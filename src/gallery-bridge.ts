import type { Context } from 'whalelife';
import type { InboundImage, MediaReceiver, MediaReference } from './inbound-media.ts';
import { registerGallerySending, type GalleryReader } from './gallery-send.ts';

export interface GalleryService extends GalleryReader {
  offerMedia(input: { sessionId: string; base64: string; source: string }, options: { signal: AbortSignal }): Promise<MediaReference>;
}
export function galleryReceiver(gallery: GalleryService, lifetime: AbortSignal): MediaReceiver {
  return async (image: InboundImage, { signal }) => {
    try {
      const combined = AbortSignal.any([lifetime, signal]);
      combined.throwIfAborted();
      if (!['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(image.mime)) return null;
      const result = await gallery.offerMedia({ sessionId: image.sessionId, base64: image.base64, source: 'qq' }, { signal: combined });
      combined.throwIfAborted();
      return result;
    } catch { return null; }
  };
}

/** Old-host compatibility only. Current hosts register directly inside QQ. */
export async function apply(ctx: Context) {
  if (typeof ctx.optional === 'function') return;
  const qq = ctx.get<{
    mediaApiVersion?: string;
    registerMediaReceiver(handle: MediaReceiver, options: { signal: AbortSignal }): Promise<() => void>;
  }>('qq');
  const gallery = ctx.get<GalleryService>('gallery');
  if (qq.mediaApiVersion !== '1.0.0' || typeof qq.registerMediaReceiver !== 'function')
    throw Error('QQ 图库接入需要 QQ 0.8.0 或兼容媒体接口。');
  let unregister: (() => void) | undefined;
  ctx.effect(() => async () => { await unregister?.(); });
  unregister = await qq.registerMediaReceiver(galleryReceiver(gallery, ctx.signal), { signal: ctx.signal });
  registerGallerySending(ctx);
}
