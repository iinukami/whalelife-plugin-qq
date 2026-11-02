import { QQError } from './config.ts';

/** Public QQ media API 1.0.0. Original bytes only; no platform URL or credentials. */
export interface InboundImage {
  sessionId: string; messageId: string; imageIndex: number; mime: string; base64: string;
}
export interface MediaReference { mediaRef: string; expiresInSeconds: number }
export type MediaReceiver = (image: InboundImage, options: { signal: AbortSignal }) => Promise<MediaReference | null>;

export class InboundMedia {
  private receiver?: { handle: MediaReceiver; signal: AbortSignal; controller: AbortController; dispose: () => void };
  register(handle: MediaReceiver, options: { signal: AbortSignal }) {
    if (typeof handle !== 'function' || !options?.signal || typeof options.signal.addEventListener !== 'function')
      throw new QQError('media_receiver', '媒体接入需要处理函数和生命周期信号。');
    options.signal.throwIfAborted();
    if (this.receiver) throw new QQError('media_receiver', '已有媒体接入启用，请先停用原接入。');
    const entry = { handle, signal: options.signal, controller: new AbortController(), dispose: () => {
      if (this.receiver === entry) this.receiver = undefined;
      entry.controller.abort();
      options.signal.removeEventListener('abort', entry.dispose);
    } };
    this.receiver = entry;
    options.signal.addEventListener('abort', entry.dispose, { once: true });
    return entry.dispose;
  }
  active() { return !!this.receiver && !this.receiver.signal.aborted; }
  dispose() { this.receiver?.dispose(); }
  async offer(image: InboundImage, signal: AbortSignal): Promise<string> {
    signal.throwIfAborted();
    const entry = this.receiver;
    if (!entry || entry.signal.aborted) return '';
    const bounded = AbortSignal.any([signal, entry.signal, entry.controller.signal, AbortSignal.timeout(15000)]);
    let onAbort: () => void = () => {};
    try {
      bounded.throwIfAborted();
      const cancelled = new Promise<never>((_, reject) => {
        onAbort = () => reject(bounded.reason);
        bounded.addEventListener('abort', onAbort, { once: true });
      });
      const result = await Promise.race([entry.handle(image, { signal: bounded }), cancelled]);
      bounded.throwIfAborted();
      if (!result || typeof result.mediaRef !== 'string' || !/^[a-zA-Z0-9_-]{1,200}$/.test(result.mediaRef)
        || !Number.isInteger(result.expiresInSeconds) || result.expiresInSeconds < 1 || result.expiresInSeconds > 86400)
        throw new QQError('media_reference', '原图接入未返回有效引用。');
      return `[原图引用 mediaRef=${result.mediaRef}；有效 ${result.expiresInSeconds} 秒；仅暂存，尚未收藏]`;
    } catch {
      signal.throwIfAborted();
      return '[本图未取得可用的原图收藏引用，尚未收藏]';
    } finally { bounded.removeEventListener('abort', onAbort); }
  }
}
