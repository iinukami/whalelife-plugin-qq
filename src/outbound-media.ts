import { createHash } from 'node:crypto';
import sharp from 'sharp';
import type { Context } from 'whalelife';
import { account, id, QQError, type Config } from './config.ts';
import { digest } from './messages.ts';
import { replyPlan } from './segmentation.ts';

export type MediaPart = { type: 'text'; text: string } | { type: 'image'; id: string; mime: string; base64: string; asMeme: boolean };
export interface MediaAction { userId: string; actionId: string; sessionId: string; personaId?: string; parts: MediaPart[] }
export interface MediaKey { userId: string; actionId: string; sessionId: string }
export interface MediaSendOptions { signal?: AbortSignal; retry?: boolean }
type Part = { type: 'text'; text: string; sourceIndex: number; interval: number }
  | { type: 'image'; id: string; mime: string; asMeme: boolean; sourceIndex: number; interval: number };
type Receipt = { state: 'unattempted' | 'pending' | 'sent' | 'failed'; messageId?: string; historyRecorded?: boolean };
interface Ledger {
  version: 1; fingerprint: string; deliveryId: string; userId: string; sessionId: string; personaId: string;
  plan: Part[]; receipts: Receipt[]; status: 'sending' | 'sent' | 'failed' | 'partial' | 'uncertain' | 'cancelled';
}
export const MAX_MEDIA_ACTION_BYTES = 25 * 1024 * 1024;
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
    parts: ledger.plan.map((p, index) => ({ index, sourceIndex: p.sourceIndex, type: p.type, ...(p.type === 'image' ? { id: p.id } : {}), ...ledger.receipts[index] })) };
}

/** Owns platform image receipts; never disguises an image as a core text message. */
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
      if (!part || !['text', 'image'].includes(part.type) || !Number.isInteger(part.sourceIndex) || part.sourceIndex < 0
        || !Number.isFinite(part.interval) || part.interval < 0 || part.interval > 60000
        || (part.type === 'text' ? typeof part.text !== 'string' || !part.text || Array.from(part.text).length > 1500
          : !/^[a-f0-9]{64}$/.test(part.id) || !['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(part.mime) || typeof part.asMeme !== 'boolean')
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
  async execute(input: MediaAction, signal: AbortSignal, retry = false) {
    signal.throwIfAborted();
    if (this.config.permission !== 'full') throw new QQError('permission', 'QQ 发图未获得完全执行权限，未发送。');
    const { file, deliveryId, userId, ledger: previous } = await this.read(input);
    if (!Array.isArray(input.parts) || !input.parts.length || input.parts.length > 16 || !input.parts.some(p => p?.type === 'image'))
      throw new QQError('input', '图文发送需要 1–16 个有序项目，并至少包含一张图片。');
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
      } else throw new QQError('input', '图文项目格式无效。');
    }
    const fingerprint = digest(canonical);
    if (previous && previous.fingerprint !== fingerprint) throw new QQError('delivery_conflict', '同一动作 ID 的图文内容不同，未发送。');
    if (previous && (!retry || previous.receipts.some(p => p.state === 'pending') || previous.status === 'sent')) return result(previous, true);
    const personaId = previous?.personaId ?? input.personaId ?? this.config.personaId;
    // Validate the trusted session without moving a channel binding or changing Web selection.
    await this.ctx.sessions.context(input.sessionId, personaId);
    signal.throwIfAborted();
    const plan: Part[] = previous?.plan ?? input.parts.flatMap((p, sourceIndex): Part[] => {
      if (p.type === 'image') return [{ type: 'image', id: p.id, mime: p.mime, asMeme: p.asMeme, sourceIndex, interval: 0 }];
      const split = replyPlan(p.text, this.config.segmentedReply, true);
      return split.texts.map((text, i) => ({ type: 'text', text, sourceIndex, interval: split.intervals[i] }));
    });
    if (!plan.length || plan.length > 64) throw new QQError('size', '图文分段后最多 64 项。');
    const ledger: Ledger = previous ?? { version: 1, deliveryId, fingerprint, userId, sessionId: input.sessionId, personaId, plan,
      receipts: plan.map(() => ({ state: 'unattempted' })), status: 'sending' };
    ledger.status = 'sending'; await this.ctx.config.save(file, ledger);
    for (let i = 0; i < plan.length; i++) {
      if (ledger.receipts[i].state === 'sent') continue;
      const part = plan[i];
      try {
        signal.throwIfAborted();
        const image = input.parts[part.sourceIndex];
        const message = part.type === 'text' ? [{ type: 'text', data: { text: part.text } }]
          : [{ type: 'image', data: { file: 'base64://' + (image as Extract<MediaPart, {type:'image'}>).base64, sub_type: part.asMeme ? 1 : 0 } }];
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
          await this.ctx.memory.recordExperience(input.sessionId, { event_id: `${deliveryId}:${i}`, outcome: 'succeeded',
            text: `向 QQ 好友 ${userId} 发送${part.type === 'text' ? '文字：' + part.text.slice(0, 300) : '图库图片 ' + part.id}；平台消息 ID ${messageId}。`,
            origin: { platform: 'QQ 私聊', action: '发送图文' } });
          ledger.receipts[i].historyRecorded = true;
        } catch { ledger.receipts[i].historyRecorded = false; }
      } catch (error) {
        const receipt = ledger.receipts[i];
        if (receipt.state === 'pending' && error instanceof QQError && error.code === 'platform_failed') receipt.state = 'failed';
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
