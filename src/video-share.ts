/*! Copyright (c) 2026 iinukami and contributors.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */
import sharp from 'sharp';
import type { Config } from './config.ts';

export type VideoShareFormat = 'miniapp' | 'card';
export type ShareMessage = Array<{ type: 'text'; data: { text: string } }
  | { type: 'image'; data: { file: string; sub_type: 0 } }
  | { type: 'json'; data: { data: string } }>;
export interface PreparedVideoCard { message: ShareMessage; coverIncluded: boolean; }
type CardInput = { title: string; description: string; previewUrl: string; webUrl: string };

/** Prepare before reserving platform delivery; never retry after dispatch. */
export async function prepareVideoCard(input: CardInput,
  config: Pick<Config, 'requestTimeoutMs' | 'maxMediaBytes'>, signal: AbortSignal,
  fetcher: typeof fetch = fetch): Promise<PreparedVideoCard> {
  signal.throwIfAborted();
  const text = [input.title, input.description, input.webUrl].filter(Boolean).join('\n');
  const message: ShareMessage = [{ type: 'text', data: { text } }];
  if (!input.previewUrl) return { message, coverIncluded: false };
  try {
    const url = new URL(input.previewUrl);
    if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash
      || !(url.hostname === 'hdslb.com' || url.hostname.endsWith('.hdslb.com'))) throw Error('cover_url');
    const limit = Math.min(config.maxMediaBytes, 5 * 1024 * 1024);
    const response = await fetcher(url, {
      signal: AbortSignal.any([signal, AbortSignal.timeout(Math.min(config.requestTimeoutMs, 15000))]),
      redirect: 'error',
    });
    const mime = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase();
    if (!response.ok || !response.body || !['image/jpeg', 'image/png', 'image/webp'].includes(mime ?? '')
      || Number(response.headers.get('content-length')) > limit) {
      await response.body?.cancel(); throw Error('cover_response');
    }
    const reader = response.body.getReader(), chunks: Buffer[] = []; let size = 0;
    try {
      while (true) {
        signal.throwIfAborted();
        const part = await reader.read(); if (part.done) break;
        size += part.value.byteLength; if (size > limit) throw Error('cover_size');
        chunks.push(Buffer.from(part.value));
      }
    } finally { await reader.cancel().catch(() => {}); }
    if (!size) throw Error('empty_cover');
    const bytes = await sharp(Buffer.concat(chunks), { limitInputPixels: 40000000 })
      .rotate().resize({ width: 1280, height: 1280, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 85 }).toBuffer();
    signal.throwIfAborted();
    if (!bytes.length || bytes.length > limit) throw Error('cover_size');
    message.unshift({ type: 'image', data: { file: 'base64://' + bytes.toString('base64'), sub_type: 0 } });
    return { message, coverIncluded: true };
  } catch {
    signal.throwIfAborted();
    // Only the optional cover failed. The complete, visible link remains the message.
    return { message, coverIncluded: false };
  }
}
