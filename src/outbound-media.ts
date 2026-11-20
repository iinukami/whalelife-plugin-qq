/*! Copyright (c) 2026 iinukami and contributors.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */
import { createHash } from 'node:crypto';
import sharp from 'sharp';
import type { Context } from 'whalelife';
import { account, id, QQError, type Config } from './config.ts';
import { digest } from './messages.ts';
import { replyPlan } from './segmentation.ts';

type VoicePart = { type: 'voice'; id: string; mime: 'audio/wav'; base64: string };
export type MediaPart = { type: 'text'; text: string } | { type: 'image'; id: string; mime: string; base64: string; asMeme: boolean } | VoicePart;
export interface MediaAction { userId: string; actionId: string; sessionId: string; personaId?: string; parts: MediaPart[] }
export interface MediaKey { userId: string; actionId: string; sessionId: string }
export interface MediaSendOptions { signal?: AbortSignal; retry?: boolean }
type Part = { type: 'text'; text: string; sourceIndex: number; interval: number }
  | { type: 'image'; id: string; mime: string; asMeme: boolean; sourceIndex: number; interval: number }
  | { type: 'voice'; id: string; mime: 'audio/wav'; sourceIndex: number; interval: number };
type Receipt = { state: 'unattempted' | 'pending' | 'sent' | 'failed'; messageId?: string; historyRecorded?: boolean };
interface Ledger {
  version: 1; fingerprint: string; deliveryId: string; userId: string; sessionId: string; personaId: string;
  plan: Part[]; receipts: Receipt[]; status: 'sending' | 'sent' | 'failed' | 'partial' | 'uncertain' | 'cancelled';
}
export const MAX_MEDIA_ACTION_BYTES = 25 * 1024 * 1024;
function validateVoice(part: VoicePart, maxBytes: number) {
  if (part.mime !== 'audio/wav' || typeof part.id !== 'string' || !/^[a-f0-9]{64}$/.test(part.id) || typeof part.base64 !== 'string')
    throw new QQError('voice', '语音条需要 WAV 数据和对应的 SHA-256。');
  if (part.base64.length > Math.ceil(maxBytes / 3) * 4) throw new QQError('size', '语音超过单次媒体大小限制。');
  const bytes = Buffer.from(part.base64, 'base64');
  if (bytes.length > maxBytes || bytes.toString('base64') !== part.base64 || createHash('sha256').update(bytes).digest('hex') !== part.id)
    throw new QQError('voice', '语音数据、编码或摘要无效。');
  const invalid = () => new QQError('voice', '需要包含有效格式和音频数据的完整 WAV 文件。');
  if (bytes.length < 44 || bytes.toString('latin1', 0, 4) !== 'RIFF' || bytes.toString('latin1', 8, 12) !== 'WAVE' ||
    bytes.readUInt32LE(4) !== bytes.length - 8) throw invalid();
  let blockAlign = 0, hasData = false;
  for (let offset = 12; offset < bytes.length;) {
    if (bytes.length - offset < 8) throw invalid();
    const kind = bytes.toString('latin1', offset, offset + 4);
    const length = bytes.readUInt32LE(offset + 4), start = offset + 8;
    offset = start + length + (length % 2);
    if (offset > bytes.length) throw invalid();
    if (kind === 'fmt ') {
      if (blockAlign || length < 16 || !bytes.readUInt16LE(start) || !bytes.readUInt16LE(start + 2) || !bytes.readUInt32LE(start + 4)) throw invalid();
      blockAlign = bytes.readUInt16LE(start + 12);
      if (!blockAlign) throw invalid();
    } else if (kind === 'data') {
      if (!blockAlign || !length || length % blockAlign) throw invalid();
      hasData = true;
    }
  }
  if (!hasData) throw invalid();
}

function platformMessage(part: Part, source: MediaPart) {
  if (part.type === 'text') return [{ type: 'text', data: { text: part.text } }];
  if (part.type === 'voice' && source.type === 'voice')
    return [{ type: 'record', data: { file: 'base64://' + source.base64 } }];
  if (part.type === 'image' && source.type === 'image')
    return [{ type: 'image', data: { file: 'base64://' + source.base64, sub_type: part.asMeme ? 1 : 0 } }];
  throw new QQError('state', '待发媒体与原发送计划不一致。');
}
export function mediaKey(input: MediaKey, config: Config) {
  if (!input || typeof input.actionId !== 'string' || !input.actionId.trim() || input.actionId.length > 128 || /[\u0000-\u001f\u007f]/.test(input.actionId)
    || typeof input.sessionId !== 'string' || !input.sessionId || input.sessionId.length > 200)
    throw new QQError('input', '需要稳定动作 ID 和可信会话 ID。');
  const userId = account(input.userId);
  if (!config.allowedUsers.includes(userId) || userId === config.accountId) throw new QQError('peer', '发送对象不在私聊白名单内。');
  return { userId, deliveryId: `qq-media:${digest([config.accountId, input.sessionId, userId, input.actionId])}` };
}
function result(ledger: Ledger, duplicate = false, error?: string) {
  const uncertain = ledger.receipts.some(p => p.state === 'pending');
  const status = ledger.receipts.every(p => p.state === 'sent') ? 'sent' : uncertain ? 'uncertain' : ledger.status === 'sending' ? 'cancelled' : ledger.status;
  return { status, confirmed: status === 'sent', duplicate, sessionId: ledger.sessionId, userId: ledger.userId, deliveryId: ledger.deliveryId,
    retryAutomatically: false, canRetry: !uncertain && status !== 'uncertain' && status !== 'sent', ...(error ? { error } : {}),
    parts: ledger.plan.map((p, index) => ({ index, sourceIndex: p.sourceIndex, type: p.type, ...(p.type !== 'text' ? { id: p.id } : {}), ...ledger.receipts[index] })) };
}

/** Tracks platform media confirmations without storing the original media bytes. */
export class OutboundMedia {
  private ctx: Context;
  private config: Config;
  private send: (userId: string, message: unknown[], interval: number, signal: AbortSignal, markPending: () => Promise<void>) => Promise<string>;
  constructor(ctx: Context, config: Config, send: OutboundMedia['send']) { this.ctx = ctx; this.config = config; this.send = send; }
  private async read(key: MediaKey) {
    const { userId, deliveryId } = mediaKey(key, this.config), file = `media-delivery-${digest(deliveryId)}.json`;
    const raw = await this.ctx.config.read<Partial<Ledger>>(file);
    if (!Object.keys(raw).length) return { file, deliveryId, userId, ledger: undefined };
    if (raw.version !== 1 || raw.deliveryId !== deliveryId || raw.userId !== userId || raw.sessionId !== key.sessionId
      || !Array.isArray(raw.plan) || !raw.plan.length || raw.plan.length > 64 || !Array.isArray(raw.receipts) || raw.receipts.length !== raw.plan.length
      || typeof raw.fingerprint !== 'string' || !['sending', 'sent', 'failed', 'partial', 'uncertain', 'cancelled'].includes(raw.status!))
      throw new QQError('state', '图文发送记录无效，已阻止重发并保留原记录。');
    for (const [i, part] of raw.plan.entries()) {
      const receipt = raw.receipts[i];
      if (!part || !['text', 'image', 'voice'].includes(part.type) || !Number.isInteger(part.sourceIndex) || part.sourceIndex < 0
        || !Number.isFinite(part.interval) || part.interval < 0 || part.interval > 60000
        || (part.type === 'text' ? typeof part.text !== 'string' || !part.text || Array.from(part.text).length > 1500
          : !/^[a-f0-9]{64}$/.test(part.id) || (part.type === 'voice'
            ? part.mime !== 'audio/wav' || raw.plan.length !== 1 || part.sourceIndex !== 0
            : !['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(part.mime) || typeof part.asMeme !== 'boolean'))
        || !receipt || !['unattempted', 'pending', 'sent', 'failed'].includes(receipt.state)
        || (receipt.state === 'sent' && (!receipt.messageId || id(receipt.messageId) === '0')))
        throw new QQError('state', '图文发送记录无效，已阻止重发并保留原记录。');
    }
    return { file, deliveryId, userId, ledger: raw as Ledger };
  }
  async status(key: MediaKey) {
    const { ledger } = await this.read(key);
    return ledger ? result(ledger, true) : { status: 'not_found', confirmed: false, retryAutomatically: false, parts: [] };
  }
  async execute(input: MediaAction, signal: AbortSignal, retry = false, beforeSend?: () => Promise<void>) {
    signal.throwIfAborted();
    if (this.config.permission !== 'full') throw new QQError('permission', 'QQ 媒体发送需要完全执行权限。');
    const { file, deliveryId, userId, ledger: previous } = await this.read(input);
    if (!Array.isArray(input.parts) || !input.parts.length || input.parts.length > 16)
      throw new QQError('input', '需要 1–16 个媒体项目。');
    const voiceOnly = input.parts.length === 1 && input.parts[0]?.type === 'voice';
    if (!voiceOnly && (input.parts.some(p => p?.type === 'voice') || !input.parts.some(p => p?.type === 'image')))
      throw new QQError('input', '图文至少需要一张图片，语音条每次单独发送一条。');
    let totalBytes = 0, images = 0, chars = 0;
    const canonical: Array<Record<string, unknown>> = [];
    for (const part of input.parts) {
      signal.throwIfAborted();
      if (part?.type === 'text' && typeof part.text === 'string' && part.text.trim()) {
        chars += Array.from(part.text).length;
        if (chars > 32000) throw new QQError('size', '单次图文文字最多 32000 字。');
        canonical.push({ type: 'text', text: part.text });
      } else if (part?.type === 'image') {
        if (++images > 8 || !/^[a-f0-9]{64}$/.test(part.id) || typeof part.asMeme !== 'boolean'
          || !['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(part.mime)
          || typeof part.base64 !== 'string' || part.base64.length > Math.ceil(MAX_MEDIA_ACTION_BYTES / 3) * 4
          || part.base64.length % 4 !== 0 || /[^A-Za-z0-9+/=]/.test(part.base64))
          throw new QQError('image', '图片数据或数量无效；最多 8 张 PNG/JPEG/WebP/GIF。');
        const bytes = Buffer.from(part.base64, 'base64'); totalBytes += bytes.length;
        if (bytes.toString('base64') !== part.base64) throw new QQError('image', '图片编码无效，未发送。');
        if (!bytes.length || bytes.length > Math.min(this.config.maxMediaBytes, MAX_MEDIA_ACTION_BYTES) || totalBytes > MAX_MEDIA_ACTION_BYTES)
          throw new QQError('size', '图片超过 QQ 单图限制或单次图文 25 MiB 总量限制。');
        if (createHash('sha256').update(bytes).digest('hex') !== part.id) throw new QQError('image', '原图与图片 ID 不匹配，未发送。');
        const metadata = await sharp(bytes, { limitInputPixels: 40000000 }).metadata();
        if ('image/' + metadata.format !== part.mime) throw new QQError('image', '图片格式不匹配，未发送。');
        canonical.push({ type: 'image', id: part.id, mime: part.mime, asMeme: part.asMeme });
      } else if (part?.type === 'voice') {
        validateVoice(part, Math.min(this.config.maxMediaBytes, MAX_MEDIA_ACTION_BYTES));
        canonical.push({ type: 'voice', id: part.id, mime: part.mime });
      } else throw new QQError('input', '媒体项目格式无效。');
    }
    const fingerprint = digest(canonical);
    if (previous && previous.fingerprint !== fingerprint) throw new QQError('delivery_conflict', '同一动作 ID 的媒体内容不同，未发送。');
    if (previous && (!retry || previous.receipts.some(p => p.state === 'pending') || previous.status === 'sent')) return result(previous, true);
    const personaId = previous?.personaId ?? input.personaId ?? this.config.personaId;
    // Validate the trusted session without moving a channel binding or changing Web selection.
    await this.ctx.sessions.context(input.sessionId, personaId);
    signal.throwIfAborted();
    const plan: Part[] = previous?.plan ?? input.parts.flatMap((p, sourceIndex): Part[] => {
      if (p.type === 'image') return [{ type: 'image', id: p.id, mime: p.mime, asMeme: p.asMeme, sourceIndex, interval: 0 }];
      if (p.type === 'voice') return [{ type: 'voice', id: p.id, mime: p.mime, sourceIndex, interval: 0 }];
      const split = replyPlan(p.text, this.config.segmentedReply, true);
      return split.texts.map((text, i) => ({ type: 'text', text, sourceIndex, interval: split.intervals[i] }));
    });
    if (!plan.length || plan.length > 64) throw new QQError('size', '图文分段后最多 64 项。');
    const ledger: Ledger = previous ?? { version: 1, deliveryId, fingerprint, userId, sessionId: input.sessionId, personaId, plan,
      receipts: plan.map(() => ({ state: 'unattempted' })), status: 'sending' };
    ledger.status = 'sending'; await this.ctx.config.save(file, ledger);
    await beforeSend?.();
    for (let i = 0; i < plan.length; i++) {
      if (ledger.receipts[i].state === 'sent') continue;
      const part = plan[i];
      try {
        signal.throwIfAborted();
        const message = platformMessage(part, input.parts[part.sourceIndex]);
        const messageId = await this.send(userId, message, part.interval, signal, async () => {
          ledger.receipts[i] = { state: 'pending' }; await this.ctx.config.save(file, ledger);
        });
        ledger.receipts[i] = { state: 'sent', messageId };
        try { await this.ctx.config.save(file, ledger); }
        catch {
          ledger.status = ledger.receipts.every(p => p.state === 'sent') ? 'sent' : 'uncertain';
          return result(ledger, false, '平台已确认本项发送，但回执保存失败；未继续发送，禁止盲目重试。');
        }
        try {
          const description = part.type === 'voice' ? '语音条' : part.type === 'image' ? '图库图片 ' + part.id : '文字：' + part.text.slice(0, 300);
          await this.ctx.memory.recordExperience(input.sessionId, { event_id: `${deliveryId}:${i}`, outcome: 'succeeded',
            text: `向 QQ 好友 ${userId} 发送${description}；平台消息 ID ${messageId}。`,
            origin: { platform: 'QQ 私聊', action: part.type === 'voice' ? '发送语音' : '发送图文' } });
          ledger.receipts[i].historyRecorded = true;
        } catch { ledger.receipts[i].historyRecorded = false; }
      } catch (error) {
        const receipt = ledger.receipts[i];
        if (receipt.state === 'pending' && error instanceof QQError &&
          (part.type === 'voice' ? error.notSent : error.code === 'platform_failed')) receipt.state = 'failed';
        const partial = ledger.receipts.some(r => r.state === 'sent');
        ledger.status = receipt.state === 'pending' ? 'uncertain' : partial ? 'partial' : signal.aborted ? 'cancelled' : 'failed';
        try { await this.ctx.config.save(file, ledger); } catch { /* Persisted pending remains conservative. */ }
        return result(ledger, false, ledger.status === 'uncertain' ? '平台结果不确定，请核对；不会自动重发。' : '发送未全部完成；已确认项目保留，后续项目已停止。');
      }
    }
    ledger.status = 'sent';
    try { await this.ctx.config.save(file, ledger); }
    catch { return result(ledger, false, '平台已确认全部发送，但最终回执未能保存。'); }
    return result(ledger);
  }
}
