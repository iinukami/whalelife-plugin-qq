/*! Copyright (c) 2026 iinukami and contributors.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */
import sharp from 'sharp';
import type { ToolContentPart } from 'whalelife';
import { QQError } from './config.ts';

export type QQChannelImage = Extract<ToolContentPart, { type: 'image' }>;
export const maxChannelImages = 16;
export const maxChannelBytes = 16 * 1024 * 1024;
const maxFrameBytes = 4 * 1024 * 1024;
const limitInputPixels = 40000000;

export async function inspectImage(bytes: Buffer) {
  const metadata = await sharp(bytes, { limitInputPixels }).metadata();
  return { bytes, mime: 'image/' + metadata.format, pages: Math.max(1, metadata.pages ?? 1) };
}

export async function imageFrames(source: Awaited<ReturnType<typeof inspectImage>>, slots: number,
  byteBudget: number, signal: AbortSignal, native: boolean): Promise<QQChannelImage[]> {
  const count = Math.min(4, source.pages, slots);
  const perFrame = Math.min(maxFrameBytes, Math.floor(byteBudget / count));
  signal.throwIfAborted();
  const frames: QQChannelImage[] = [];
  for (let i = 0; i < count; i++) {
    signal.throwIfAborted();
    const page = count === 1 ? 0 : Math.floor(i * (source.pages - 1) / (count - 1));
    // Re-encode visible pixels even when the source fits. EXIF/GPS, XMP and trailing
    // bytes belong to the original kept for the gallery, never to a model input.
    let side = 1536;
    if (native) side = source.pages === 1 && source.bytes.length <= perFrame ? 4096 : 2048;
    const frame = sharp(source.bytes, { page, pages: 1, limitInputPixels }).autoOrient()
      .resize(side, side, { fit: 'inside', withoutEnlargement: true });
    let mimeType: QQChannelImage['mimeType'] = 'image/png';
    if (native && source.mime === 'image/jpeg') { frame.jpeg({ quality: 93 }); mimeType = 'image/jpeg'; }
    else if (native && source.mime === 'image/webp') { frame.webp({ quality: 91 }); mimeType = 'image/webp'; }
    else frame.png();
    const rendered = await frame.toBuffer();
    signal.throwIfAborted();
    if (!native || rendered.length <= perFrame) {
      frames.push({ type: 'image', mimeType, data: rendered });
      continue;
    }
    let webp = await sharp(rendered).resize(2048, 2048, { fit: 'inside', withoutEnlargement: true }).webp({ quality: 82 }).toBuffer();
    if (webp.length > perFrame) {
      signal.throwIfAborted();
      // Leave space for alpha, headers and compression overhead even for high-entropy pixels.
      const smallSide = Math.floor(Math.sqrt(perFrame / 5));
      webp = await sharp(rendered).resize(smallSide, smallSide, { fit: 'inside', withoutEnlargement: true })
        .webp({ quality: 76 }).toBuffer();
    }
    signal.throwIfAborted();
    if (webp.length > perFrame) throw new QQError('image_size', '图片转码后仍超过主模型的单图容量限制。');
    frames.push({ type: 'image', mimeType: 'image/webp', data: webp });
  }
  return frames;
}
