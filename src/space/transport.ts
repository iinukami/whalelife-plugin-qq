import { createHash } from 'node:crypto';
import sharp from 'sharp';
import type { PublishPayload, TransportReceipt } from './types.ts';
import { QZONE_LIMITS } from './policy.ts';
import type { OneBot } from '../onebot.ts';

export async function validateImages(input: PublishPayload) {
  if (!Array.isArray(input.images) || input.images.length > QZONE_LIMITS.images) throw Error('images');
  let total = 0;
  for (const p of input.images) {
    if (!p || !/^[a-f0-9]{64}$/.test(p.id) || typeof p.base64 !== 'string' || p.base64.length > Math.ceil(QZONE_LIMITS.bytes / 3) * 4
      || !['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(p.mime)) throw Error('image');
    const bytes = Buffer.from(p.base64, 'base64'); total += bytes.length;
    if (!bytes.length || total > QZONE_LIMITS.bytes || bytes.toString('base64') !== p.base64
      || createHash('sha256').update(bytes).digest('hex') !== p.id) throw Error('image');
    const info = await sharp(bytes, { limitInputPixels: QZONE_LIMITS.pixels }).metadata();
    if ('image/' + info.format !== p.mime || (info.width ?? 0) * (info.height ?? 0) > QZONE_LIMITS.pixels) throw Error('image');
  }
}

/** Parent owns the connection. No retry, no credentials returned, separate from private-chat queue. */
export class SpaceTransport {
  private busy = false;
  private bot: OneBot;
  private signal: AbortSignal;
  private identity: () => { accountId: string; online: boolean };
  constructor(bot: OneBot, signal: AbortSignal, identity: SpaceTransport['identity']) {
    this.bot = bot; this.signal = signal; this.identity = identity;
  }
  async publish(input: PublishPayload, options: { signal: AbortSignal }): Promise<TransportReceipt> {
    let submitted = false;
    if (this.busy) return { status: 'not_submitted', error: '空间正在处理另一项发布，本次未提交。' };
    this.busy = true;
    try {
      const signal = AbortSignal.any([this.signal, options.signal]); signal.throwIfAborted();
      if (!input || input.visibility !== 'public' || typeof input.content !== 'string' || Array.from(input.content).length > QZONE_LIMITS.text
        || /@\{|\[CQ:at\b/i.test(input.content)) throw Error('input');
      await validateImages(input);
      if (!input.content.trim() && !input.images.length) throw Error('input');
      signal.throwIfAborted();
      const current = this.identity();
      if (!current.online || current.accountId !== input.accountId) throw Error('identity');
      submitted = true;
      const result = await this.bot.request('send_qzone_msg', {
        content: input.content, images: input.images.map(p => 'base64://' + p.base64), ugc_right: 1,
      }, signal, false, 120000);
      if (typeof result.tid !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(result.tid) || result.tid === '0')
        return { status: 'uncertain', error: '协议端未返回真实说说 ID，请人工核对，禁止重发。' };
      return { status: 'sent', tid: result.tid };
    } catch {
      return submitted ? { status: 'uncertain', error: '已提交的空间操作结果不确定；不会自动重发。' }
        : { status: 'not_submitted', error: '空间发布未提交，请检查账号、连接和图片参数。' };
    } finally { this.busy = false; }
  }
}
