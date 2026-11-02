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
export function segments(input: unknown): Segment[] {
  let result: Segment[];
  if (Array.isArray(input)) {
    result = input.map(value => { const s = object(value); return { type: String(s.type ?? '').slice(0, 32), data: object(s.data) }; });
  } else if (typeof input === 'string') {
    result = []; let pos = 0;
    for (const match of input.matchAll(/\[CQ:([a-z_]+)((?:,[^\]]*)?)\]/g)) {
      if (match.index > pos) result.push({ type: 'text', data: { text: unescape(input.slice(pos, match.index)) } });
      const data: Record<string, string> = Object.create(null);
      for (const item of match[2].slice(1).split(',')) {
        const i = item.indexOf('='); if (i > 0) data[item.slice(0, i)] = unescape(item.slice(i + 1));
      }
      result.push({ type: match[1], data }); pos = match.index + match[0].length;
    }
    if (pos < input.length) result.push({ type: 'text', data: { text: unescape(input.slice(pos)) } });
  } else throw new QQError('message', '消息格式无效。');
  if (result.length > 128) throw new QQError('message', '消息段数量过多。');
  return result;
}
export function privateEvent(raw: Record<string, unknown>, config: Config): PrivateEvent | null {
  if (raw.post_type !== 'message' || raw.message_type !== 'private' || raw.sub_type !== 'friend') return null;
  if (account(raw.self_id) !== config.accountId) return null;
  const sender = account(raw.user_id);
  if (sender === config.accountId || !config.allowedUsers.includes(sender)) return null;
  const messageId = id(raw.message_id), parts = segments(raw.message ?? raw.raw_message);
  const stable = parts.map(({ type, data }) => {
    if (type === 'text') return [type, data.text];
    if (['image', 'record', 'mface'].includes(type)) return [type, data.file ?? data.file_id ?? data.url, data.emoji_id];
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
