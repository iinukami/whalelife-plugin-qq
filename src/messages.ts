/*! Copyright (c) 2026 iinukami and contributors.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */
import { createHash } from 'node:crypto';
import { account, id, object, QQError, type Config } from './config.ts';

export interface Segment { type: string; data: Record<string, unknown>; }
export interface PrivateEvent { sender: string; messageId: string; peer: string; segments: Segment[]; fingerprint: string; }
export const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function unescape(value: string) { return value.replaceAll('&#91;', '[').replaceAll('&#93;', ']').replaceAll('&#44;', ',').replaceAll('&amp;', '&'); }
export const EVENT_LIMIT = 256 * 1024;
export const MAX_INLINE_EVENT_BYTES = 25 * 1024 * 1024;
export function imageSource(data: Record<string, unknown>): unknown {
  if (typeof data.url === 'string' && data.url.startsWith('base64://')) return data.url;
  if (typeof data.file === 'string' && data.file.startsWith('base64://')) return data.file;
  return data.url;
}

export function inlineSize(source: string, limit: number) {
  let body = source.slice('base64://'.length);
  const maxChars = 4 * Math.ceil(limit / 3);
  if (body.length > 2 * maxChars + EVENT_LIMIT) throw new QQError('size', '媒体超过大小限制。');
  body = body.replace(/[\t\r\n ]+/g, '');
  if (body.length > maxChars) throw new QQError('size', '媒体超过大小限制。');
  const padding = body.endsWith('==') ? 2 : body.endsWith('=') ? 1 : 0;
  const chars = body.length - padding;
  if (!chars || chars % 4 === 1 || (padding && body.length % 4 !== 0) || /[^A-Za-z0-9+/_-]/.test(body.slice(0, chars)))
    throw new QQError('media_encoding', '内联媒体的 Base64 编码无效。');
  const size = Math.floor(chars * 3 / 4);
  if (size > limit) throw new QQError('size', '媒体超过大小限制。');
  return { bytes: size, characters: body.length };
}

function inlineImages(parts: Segment[]) {
  return parts.flatMap(({ type, data }) => {
    if (type !== 'image' && type !== 'mface') return [];
    const source = imageSource(data);
    if (typeof source !== 'string' || !source.startsWith('base64://')) return [];
    return [{ source, copies: data.file === source && data.url === source ? 2 : 1 }];
  });
}

function checkImageEnvelope(parts: Segment[], raw: Record<string, unknown>, config: Config, wireBytes: number) {
  const images = inlineImages(parts);
  if (images.length > config.maxMediaItems) throw new QQError('media_count', '媒体数量超过限制。');
  let total = 0;
  const sizes = images.map(image => {
    const size = inlineSize(image.source, config.maxMediaBytes);
    total += size.bytes;
    if (total > MAX_INLINE_EVENT_BYTES) throw new QQError('size', '单条消息的内联图片合计超过 25 MiB 大小限制。');
    wireBytes -= size.characters * image.copies;
    return size;
  });
  // Only discount a raw CQ mirror when its image bytes match the primary segments in order.
  if (wireBytes > EVENT_LIMIT && images.length && raw.message != null && typeof raw.raw_message === 'string') {
    const mirror = inlineImages(segments(raw.raw_message));
    if (mirror.length === images.length && mirror.every((img, i) => img.source === images[i].source))
      for (let i = 0; i < mirror.length; i++) wireBytes -= sizes[i].characters * mirror[i].copies;
  }
  if (wireBytes > EVENT_LIMIT) throw new QQError('event_size', 'QQ 事件中图片以外的数据超过 256 KiB 大小限制。');
}

export function segments(input: unknown): Segment[] {
  let result: Segment[];
  if (Array.isArray(input)) {
    if (input.length > 128) throw new QQError('message', '消息段数量过多。');
    result = input.map(value => { const s = object(value); return { type: String(s.type ?? '').slice(0, 32), data: object(s.data) }; });
  } else if (typeof input === 'string') {
    result = []; let pos = 0;
    // Exclude an unmatched trailing CQ prefix before scanning potentially large inline images.
    const lastEnd = input.lastIndexOf(']');
    for (const match of input.slice(0, lastEnd + 1).matchAll(/\[CQ:([a-z_]+)((?:,[^\]]*)?)\]/g)) {
      if (result.length >= 128) throw new QQError('message', '消息段数量过多。');
      if (match.index > pos) result.push({ type: 'text', data: { text: unescape(input.slice(pos, match.index)) } });
      const data: Record<string, string> = Object.create(null);
      const fields = match[2].slice(1).split(',', 129);
      if (fields.length > 128) throw new QQError('message', '消息段字段过多。');
      for (const item of fields) {
        const i = item.indexOf('='); if (i > 0) data[item.slice(0, i)] = unescape(item.slice(i + 1));
      }
      result.push({ type: match[1], data }); pos = match.index + match[0].length;
    }
    if (pos < input.length) result.push({ type: 'text', data: { text: unescape(input.slice(pos)) } });
  } else throw new QQError('message', '消息格式无效。');
  if (result.length > 128) throw new QQError('message', '消息段数量过多。');
  return result;
}
export function privateSender(raw: Record<string, unknown>, config: Config): string | null {
  if (raw.post_type !== 'message' || raw.message_type !== 'private' || raw.sub_type !== 'friend') return null;
  try {
    if (account(raw.self_id) !== config.accountId) return null;
    const sender = account(raw.user_id);
    return sender !== config.accountId && config.allowedUsers.includes(sender) ? sender : null;
  } catch { return null; }
}
export function privateEvent(raw: Record<string, unknown>, config: Config, wireBytes = 0): PrivateEvent | null {
  const sender = privateSender(raw, config);
  if (!sender) return null;
  const messageId = id(raw.message_id), parts = segments(raw.message ?? raw.raw_message);
  if (wireBytes > EVENT_LIMIT) checkImageEnvelope(parts, raw, config, wireBytes);
  const stable = parts.map(({ type, data }) => {
    if (type === 'text') return [type, data.text];
    if (type === 'json' || type === 'xml') return [type, digest(data.data ?? null)];
    if (type === 'share') return [type, data.url, data.title, data.content];
    if (type === 'image' || type === 'mface') {
      const source = imageSource(data);
      if (typeof source === 'string' && source.startsWith('base64://')) return [type, source, data.emoji_id];
    }
    if (type === 'image' || type === 'mface' || type === 'record') return [type, data.file ?? data.file_id ?? data.url, data.emoji_id];
    return [type, data.id, data.qq, data.summary ?? data.text];
  });
  return { sender, messageId, peer: `direct:${sender}`, segments: parts, fingerprint: digest([sender, stable]) };
}
export function splitText(text: string, max = 1500): string[] {
  const points = Array.from(text), chunks: string[] = [];
  while (points.length) {
    let end = Math.min(max, points.length);
    if (end < points.length) {
      const newline = points.lastIndexOf('\n', end - 1);
      if (newline >= max / 2) end = newline + 1;
    }
    chunks.push(points.splice(0, end).join(''));
  }
  return chunks;
}
// Textual names are preferred when supplied by the protocol endpoint.
const faces: Record<string, string> = {
  '0':'惊讶','1':'撇嘴','2':'色','3':'发呆','4':'得意','5':'流泪','6':'害羞','7':'闭嘴','8':'睡觉','9':'大哭',
  '10':'尴尬','11':'发怒','12':'调皮','13':'呲牙','14':'微笑','15':'难过','16':'酷','18':'抓狂','19':'吐',
  '20':'偷笑','21':'可爱','22':'白眼','23':'傲慢','24':'饥饿','25':'困','26':'惊恐','27':'流汗','28':'憨笑',
  '29':'悠闲','30':'奋斗','31':'咒骂','32':'疑问','33':'嘘','34':'晕','35':'折磨','36':'衰','37':'骷髅',
  '38':'敲打','39':'再见','49':'拥抱','53':'蛋糕','59':'便便','60':'咖啡','63':'玫瑰','64':'凋谢',
  '66':'爱心','67':'心碎','74':'太阳','75':'月亮','76':'赞','77':'踩','78':'握手','79':'胜利',
  '96':'冷汗','97':'擦汗','98':'抠鼻','99':'鼓掌','100':'糗大了','101':'坏笑','102':'左哼哼','103':'右哼哼',
  '104':'哈欠','105':'鄙视','106':'委屈','107':'快哭了','109':'左亲亲','110':'吓','111':'可怜',
  '144':'喝彩','146':'爆筋','171':'茶','172':'眨眼睛','173':'泪奔','174':'无奈','175':'卖萌',
  '178':'斜眼笑','180':'惊喜','181':'骚扰','182':'笑哭','183':'我最美','201':'点赞','212':'托腮',
};
export function faceText(data: Record<string, unknown>) {
  const label = typeof data.text === 'string' ? data.text : typeof data.summary === 'string' ? data.summary : faces[String(data.id)];
  return label ? `[QQ表情：${label.slice(0, 100)}]` : null;
}
