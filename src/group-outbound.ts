/*! Copyright (c) 2026 iinukami and contributors.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */
import sharp from 'sharp';
import type { Context } from 'whalelife';
import { account, id, QQError, safeError, type Config } from './config.ts';
import { digest, type Segment } from './messages.ts';
import { MAX_MEDIA_ACTION_BYTES, validateWavBytes } from './outbound-media.ts';

export type GroupSegment = Segment;
export type GroupTextInput = { groupId: string; text: string; atUserIds?: string[]; replyTo?: string; actionId?: string };
export type GroupMediaInput = { groupId: string; parts: Array<
  { type: 'text'; text: string } | { type: 'image'; base64: string; mime: string; asMeme?: boolean } |
  { type: 'voice'; base64: string; mime: string }>; actionId?: string };
type Transport = {
  authorize(groupId: string): void | Promise<void>;
  canQuote(groupId: string, messageId: string): boolean;
  submit(groupId: string, message: GroupSegment[], signal: AbortSignal, beforeSubmit: () => Promise<void>): Promise<string>;
};
type Receipt = { status: 'sent' | 'not_submitted' | 'uncertain'; confirmed: boolean; retryAutomatically: false;
  messageId?: string; duplicate?: boolean; error?: string };
type Ledger = { version: 1; key: string; fingerprint: string; status: Receipt['status']; messageId?: string };
const failed = (status: 'not_submitted' | 'uncertain', error: string): Receipt =>
  ({ status, confirmed: false, retryAutomatically: false, error });
const sent = (messageId: string): Receipt => ({ status: 'sent', confirmed: true, retryAutomatically: false, messageId });
const unclear = '群消息提交结果不确定，请核对；不要重发或改用其他形式补发。';

function textPart(value: unknown): GroupSegment {
  if (typeof value !== 'string' || !value.trim() || value.length > 8000 || Array.from(value).length > 4000)
    throw new QQError('input', '每项群文字限 1–4000 字。', true);
  return { type: 'text', data: { text: value } };
}
function realMessageId(value: unknown): string {
  const result = id(value);
  if (result === '0') throw new QQError('invalid_id', '需要非零消息 ID。');
  return result;
}
async function mediaSegments(input: GroupMediaInput, maxBytes: number, signal: AbortSignal) {
  const parts = input.parts;
  if (!Array.isArray(parts) || !parts.length || parts.length > 16)
    throw new QQError('input', '群媒体需要 1–16 项。', true);
  const voiceOnly = parts.length === 1 && parts[0]?.type === 'voice';
  if (!voiceOnly && !parts.some(part => part?.type === 'image')) throw new QQError('input', '群图文需要图片，语音每次单独发送一条。', true);
  const result: GroupSegment[] = [];
  let total = 0, images = 0;
  for (const part of parts) {
    signal.throwIfAborted();
    if (part?.type === 'text') { result.push(textPart(part.text)); continue; }
    if (part?.type !== 'image' && !(voiceOnly && part?.type === 'voice'))
      throw new QQError('input', '群媒体项目类型无效。', true);
    const remaining = Math.min(maxBytes, MAX_MEDIA_ACTION_BYTES - total);
    if (typeof part.base64 !== 'string' || !part.base64.length || part.base64.length > Math.ceil(remaining / 3) * 4)
      throw new QQError('media', '群媒体编码为空或超过大小限制。', true);
    const bytes = Buffer.from(part.base64, 'base64');
    if (!bytes.length || bytes.length > remaining || bytes.toString('base64') !== part.base64)
      throw new QQError('media', '群媒体编码无效或超过大小限制。', true);
    total += bytes.length;
    const file = 'base64://' + part.base64;
    if (part.type === 'voice') {
      if (part.mime !== 'audio/wav') throw new QQError('voice', '群语音需要 WAV 音频。', true);
      validateWavBytes(bytes);
      result.push({ type: 'record', data: { file } });
    } else {
      if (++images > 8 || !['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(part.mime) ||
        (part.asMeme !== undefined && typeof part.asMeme !== 'boolean')) throw new QQError('image', '群图片数量或格式无效。', true);
      const meta = await sharp(bytes, { limitInputPixels: 40000000 }).metadata();
      if ('image/' + meta.format !== part.mime) throw new QQError('image', '群图片格式不匹配。', true);
      result.push({ type: 'image', data: { file, sub_type: part.asMeme ? 1 : 0 } });
    }
  }
  return result;
}

export class GroupOutbound {
  private inflight = new Map<string, { fingerprint: string; promise: Promise<Receipt> }>();
  private ctx: Context;
  private config: Config;
  private transport: Transport;
  constructor(ctx: Context, config: Config, transport: Transport) {
    this.ctx = ctx; this.config = config; this.transport = transport;
  }

  async sendText(input: GroupTextInput, signal: AbortSignal) {
    const groupId = account(input?.groupId);
    signal.throwIfAborted(); await this.transport.authorize(groupId);
    const message: GroupSegment[] = [];
    const quote = input.replyTo === undefined ? undefined : realMessageId(input.replyTo);
    if (quote) message.push({ type: 'reply', data: { id: quote } });
    const targets = input.atUserIds === undefined ? [] : input.atUserIds;
    if (!Array.isArray(targets) || targets.length > 3) throw new QQError('input', '群消息最多提及三名成员。', true);
    for (const target of new Set(targets.map(account))) {
      if (target === this.config.accountId) throw new QQError('input', '不能提及机器人自己。', true);
      message.push({ type: 'at', data: { qq: target } });
    }
    message.push(textPart(input.text));
    const receipt = await this.deliver(groupId, input.actionId, message, quote, signal);
    // Community 0.6.6 treats any resolved sendGroupText result as a platform acknowledgement.
    if (receipt.status !== 'sent') throw new QQError(receipt.status, receipt.error ?? unclear, receipt.status === 'not_submitted');
    return receipt;
  }

  async sendMedia(input: GroupMediaInput, signal: AbortSignal): Promise<Receipt> {
    try {
      const groupId = account(input?.groupId);
      signal.throwIfAborted(); await this.transport.authorize(groupId);
      const message = await mediaSegments(input, this.config.maxMediaBytes, signal);
      return await this.deliver(groupId, input.actionId, message, undefined, signal);
    } catch (error) {
      return failed('not_submitted', safeError(error));
    }
  }

  private async deliver(groupId: string, actionId: string | undefined, message: GroupSegment[], quote: string | undefined, signal: AbortSignal) {
    if (actionId === undefined) return this.submit(groupId, message, quote, signal);
    if (typeof actionId !== 'string' || !actionId.trim() || actionId.length > 128 || /[\u0000-\u001f\u007f]/.test(actionId))
      throw new QQError('input', '需要有效且稳定的群发送动作 ID。', true);
    const key = digest([this.config.accountId, groupId, actionId]), fingerprint = digest(message);
    const active = this.inflight.get(key);
    if (active) {
      if (active.fingerprint !== fingerprint) throw new QQError('conflict', '同一群发送动作 ID 的内容不同。', true);
      return { ...await active.promise, duplicate: true };
    }
    const ledger: Ledger = { version: 1, key, fingerprint, status: 'uncertain' };
    const promise = this.submit(groupId, message, quote, signal, ledger);
    this.inflight.set(key, { fingerprint, promise });
    try { return await promise; } finally { this.inflight.delete(key); }
  }

  private async submit(groupId: string, message: GroupSegment[], quote: string | undefined, signal: AbortSignal, ledger?: Ledger): Promise<Receipt> {
    const file = ledger ? 'group-delivery-' + ledger.key + '.json' : '';
    if (ledger) {
      // If an earlier receipt cannot be read, a fresh action with the same key is unsafe.
      let existing: Record<string, unknown>;
      try { existing = await this.ctx.config.read(file); } catch { return failed('uncertain', unclear); }
      if (!existing || typeof existing !== 'object' || Array.isArray(existing)) return failed('uncertain', unclear);
      if (Object.keys(existing).length) {
        if (existing.version !== 1 || existing.key !== ledger.key) return failed('uncertain', unclear);
        if (existing.fingerprint !== ledger.fingerprint) throw new QQError('conflict', '同一群发送动作 ID 的内容不同。', true);
        let receipt = failed('uncertain', unclear);
        if (existing.status === 'sent') {
          try { receipt = sent(realMessageId(existing.messageId)); } catch { /* Damaged evidence must not trigger a resend. */ }
        } else if (existing.status === 'not_submitted') receipt = failed('not_submitted', '此动作先前未提交。');
        return { ...receipt, duplicate: true };
      }
    }
    let pending = false, recorded = false, receipt: Receipt;
    try {
      const messageId = await this.transport.submit(groupId, message, signal, async () => {
        signal.throwIfAborted();
        if (ledger) { await this.ctx.config.save(file, ledger); recorded = true; }
        await this.transport.authorize(groupId);
        if (quote && !this.transport.canQuote(groupId, quote)) throw new QQError('quote', '只能引用当前群已接收的消息。', true);
        signal.throwIfAborted();
        pending = true;
      });
      receipt = sent(realMessageId(messageId));
    } catch (error) {
      receipt = pending && !(error instanceof QQError && error.notSent)
        ? failed('uncertain', unclear) : failed('not_submitted', safeError(error));
    }
    if (recorded && ledger && receipt.status !== 'uncertain') {
      try { await this.ctx.config.save(file, { ...ledger, status: receipt.status, messageId: receipt.messageId }); }
      catch { /* The durable pending receipt still blocks replay. Preserve any platform confirmation for this caller. */ }
    }
    return receipt;
  }
}
