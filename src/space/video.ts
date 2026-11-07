/*! Copyright (c) 2026 iinukami and contributors.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */
import type { Response } from 'undici';
import { QQError } from '../config.ts';

export const VIDEO_BYTES = 64 * 1024 * 1024;
/** Verified QZone native-video origin. Third-party players and cover images are
 * not download sources. Signed query values remain inside the sealed reference. */
export function videoUrl(raw: string): string | undefined {
  try {
    const u = new URL(raw.startsWith('//') ? 'https:' + raw : raw);
    if (raw.length > 4096 || !['http:', 'https:'].includes(u.protocol) || u.username || u.password || u.port || u.hash
      || u.hostname !== 'photovideo.photo.qq.com' || !/\.(mp4|webm)$/i.test(u.pathname)) return;
    u.protocol = 'https:'; return u.href.length <= 4096 ? u.href : undefined;
  } catch { return; }
}
function videoMime(bytes: Buffer): 'video/mp4' | 'video/webm' {
  if (bytes.length >= 16 && bytes.toString('ascii', 4, 8) === 'ftyp'
    && /^(isom|iso[2-9]|mp4[12]|avc1|M4V |MSNV|dash)$/.test(bytes.toString('ascii', 8, 12))) return 'video/mp4';
  // EBML DocType element (0x4282) with the exact four-byte value "webm".
  if (bytes.length >= 12 && bytes.readUInt32BE(0) === 0x1a45dfa3
    && bytes.subarray(0, 4096).includes(Buffer.from([0x42, 0x82, 0x84, 0x77, 0x65, 0x62, 0x6d]))) return 'video/webm';
  throw new QQError('video_format', '视频格式不受支持，仅支持 MP4/WebM 原始文件。');
}
export async function readVideoBytes(response: Response, signal: AbortSignal, check: () => void) {
  const headerSize = response.headers.get('content-length');
  if (!response.ok || response.status !== 200 || !response.body || (headerSize !== null &&
    (!/^\d+$/.test(headerSize) || !Number.isSafeInteger(Number(headerSize)) || Number(headerSize) > VIDEO_BYTES))) {
    void response.body?.cancel().catch(() => {});
    throw new QQError('video_response', '视频下载失败或超过 64 MiB 上限。');
  }
  const mime = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase();
  if (mime && !['video/mp4', 'video/webm', 'application/octet-stream', 'binary/octet-stream'].includes(mime)) {
    void response.body.cancel().catch(() => {});
    throw new QQError('video_format', '视频格式不受支持，仅支持 MP4/WebM 原始文件。');
  }
  const reader = response.body.getReader(), chunks: Buffer[] = []; let size = 0, done = false, abort = () => {};
  try {
    signal.throwIfAborted(); check();
    const cancelled = new Promise<never>((_, reject) => {
      abort = () => { void reader.cancel().catch(() => {}); reject(new QQError('video_cancelled', '视频读取已取消或超时。')); };
      if (signal.aborted) abort(); else signal.addEventListener('abort', abort, { once: true });
    });
    for (;;) {
      signal.throwIfAborted(); check();
      const part = await Promise.race([reader.read(), cancelled]);
      signal.throwIfAborted(); check();
      if (part.done) { done = true; break; }
      size += part.value.byteLength;
      if (size > VIDEO_BYTES) throw new QQError('video_size', '视频超过 64 MiB 上限，未交付。');
      chunks.push(Buffer.from(part.value));
    }
    if (headerSize !== null && size !== Number(headerSize)) throw new QQError('video_response', '视频下载不完整，未交付。');
    const bytes = Buffer.concat(chunks, size), detected = videoMime(bytes);
    if (mime?.startsWith('video/') && mime !== detected) throw new QQError('video_format', '视频格式与声明不一致，未交付。');
    return { mime: detected, base64: bytes.toString('base64') };
  } finally {
    signal.removeEventListener('abort', abort);
    if (!done) void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
