/*! Copyright (c) 2026 iinukami and contributors.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */
import { parseFragment, type DefaultTreeAdapterMap } from 'parse5';
import JSON5 from 'json5';
import { object, QQError } from '../config.ts';
import type { PostTarget } from './types.ts';
import { videoUrl } from './video.ts';

type Node = DefaultTreeAdapterMap['node'];
const attr = (n: Node, k: string) => 'attrs' in n ? n.attrs.find(a => a.name === k)?.value ?? '' : '';
const cls = (n: Node, k: string) => attr(n, 'class').split(/\s+/).includes(k);
function nodes(n: Node): Node[] {
  const result: Node[] = [], stack = [n];
  while (stack.length) { const v = stack.pop()!; result.push(v); if ('childNodes' in v) stack.push(...v.childNodes.toReversed()); }
  return result;
}
function text(n: Node, omit?: (node: Node) => boolean): string {
  if (omit?.(n)) return '';
  if (n.nodeName === '#text') return (n as DefaultTreeAdapterMap['textNode']).value;
  if (['script', 'style', 'iframe'].includes(n.nodeName)) return '';
  if (n.nodeName === 'br') return '\n';
  if (n.nodeName === 'img') return attr(n, 'alt').slice(0, 100);
  return 'childNodes' in n ? n.childNodes.map(child => text(child, omit)).join('') : '';
}
const clean = (n?: Node, limit = 10000, omit?: (node: Node) => boolean) => n ? text(n, omit).replace(/\u00a0/g, ' ').trim().slice(0, limit) : '';
const validId = (s: string) => /^[a-zA-Z0-9_-]{1,128}$/.test(s) && s !== '0';
const validUin = (s: string) => /^[1-9]\d{4,19}$/.test(s);
/** Legacy JSONP may use undefined for missing fields. Convert that token only;
 * quoted user text, escapes and comments are left byte-for-byte unchanged. */
function missingValues(s: string): string {
  const chunks: string[] = []; let i = 0;
  while (i < s.length) {
    const start = i, ch = s[i++];
    if (ch === '"' || ch === "'") {
      while (i < s.length) { const c = s[i++]; if (c === '\\') i++; else if (c === ch) break; }
    } else if (ch === '/' && s[i] === '/') { while (i < s.length && s[i] !== '\n') i++; }
    else if (ch === '/' && s[i] === '*') { i++; while (i < s.length && !(s[i - 1] === '*' && s[i] === '/')) i++; i = Math.min(s.length, i + 1); }
    else if (/[a-zA-Z_$]/.test(ch)) {
      while (i < s.length && /[\w$]/.test(s[i])) i++;
      if (s.slice(start, i) === 'undefined') { chunks.push('null'); continue; }
    }
    chunks.push(s.slice(start, i));
  }
  return chunks.join('');
}
function skipLiteral(s: string, i: number): number {
  const quote = s[i];
  if (quote === '"' || quote === "'") {
    for (let j = i + 1; j < s.length; j++) { if (s[j] === '\\') j++; else if (s[j] === quote) return j + 1; }
    return s.length;
  }
  if (s.slice(i, i + 2) === '//') { const end = s.indexOf('\n', i + 2); return end < 0 ? s.length : end; }
  if (s.slice(i, i + 2) === '/*') { const end = s.indexOf('*/', i + 2); return end < 0 ? s.length : end + 2; }
  return i;
}
/** The legacy form endpoint wraps its data callback in HTML. Read only the fixed
 * callback's literal argument; ignore scripts instead of evaluating any of them. */
function htmlPayload(raw: string): string {
  const args: string[] = [];
  for (const node of nodes(parseFragment(raw)).filter(n => n.nodeName === 'script')) {
    const s = 'childNodes' in node ? node.childNodes.map(n => n.nodeName === '#text' ? (n as DefaultTreeAdapterMap['textNode']).value : '').join('') : '';
    for (let i = 0; i < s.length;) {
      const skipped = skipLiteral(s, i); if (skipped > i) { i = skipped; continue; }
      const match = /^frameElement\.callback\s*\(/.exec(s.slice(i));
      if (!match || (i > 0 && /[\w$.]/.test(s[i - 1]))) { i++; continue; }
      let j = i + match[0].length, depth = 1; const start = j;
      for (; j < s.length && depth; j++) {
        const next = skipLiteral(s, j); if (next > j) { j = next - 1; continue; }
        if (s[j] === '(') depth++; else if (s[j] === ')') depth--;
      }
      if (depth) throw new QQError('response', '空间响应格式不受支持。');
      args.push(s.slice(start, j - 1)); i = j;
    }
  }
  if (args.length !== 1) throw new QQError('response', '空间返回了 HTML 页面，当前登录态或访问方式可能不适用。');
  return args[0];
}
/** A fixed media-origin allowlist. URLs never come from model arguments; no redirects/cookies. */
export function imageUrl(raw: string): string | undefined {
  try {
    const u = new URL(raw.startsWith('//') ? 'https:' + raw : raw);
    if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password || u.port || raw.length > 4096) return;
    if (!['qpic.cn', 'photo.store.qq.com', 'photo.store.qq.com.cn'].some(h => u.hostname === h || u.hostname.endsWith('.' + h))) return;
    u.protocol = 'https:'; return u.href;
  } catch { return; }
}
/** Only JSON / JSONP data is accepted. Never evaluate a page's JavaScript. */
export function responseObject(raw: string): Record<string, unknown> {
  let s = raw.trim();
  if (s.startsWith('<')) s = htmlPayload(s).trim();
  if (!s.startsWith('{')) {
    const m = /^(?:[a-zA-Z_$][\w$]*\.)*[a-zA-Z_$][\w$]*\s*\(([\s\S]*)\)\s*;?$/.exec(s);
    if (!m) throw new QQError('response', s.startsWith('<') ? '空间返回了 HTML 页面，当前登录态或访问方式可能不适用。' : '空间响应没有可识别的 JSON/JSONP 外层。'); s = m[1];
  }
  try { return object(JSON.parse(s)); }
  catch {
    // QZone's live JSONP also uses JS string escapes, single quotes and unquoted
    // property names. JSON5 reads data literals only; it cannot evaluate calls/code.
    try { return object(JSON5.parse(missingValues(s))); }
    catch (error) {
      const v = error as { lineNumber?: number; columnNumber?: number; message?: string };
      const ch = /invalid character '([^']*)'/.exec(v.message ?? '')?.[1] ?? '';
      throw new QQError('response', `空间响应解析失败（行 ${Number(v.lineNumber) || 0}，列 ${Number(v.columnNumber) || 0}，字符码 ${ch.codePointAt(0) ?? 0}）。`);
    }
  }
}
export function successful(v: Record<string, unknown>): boolean {
  const codes = [v.code, v.ret, v.subcode].filter(x => x !== undefined);
  return codes.length > 0 && codes.every(x => x === 0 || x === '0');
}
export interface ParsedPost extends PostTarget { text: string; images: string[]; videos: string[]; hasVideo: boolean; comments: (PostTarget['comments'][number] & { text: string })[] }
/** scope=0 profile response owns friend_data; the other buckets contain activity
 * about the owner and must never be mixed in as the owner's posts. */
export function parseProfileFeeds(raw: string, accountId: string, count: number, start: number) {
  const envelope = responseObject(raw);
  if (!successful(envelope)) throw new QQError('qzone_auth', '空间未返回可用动态，请检查登录、空间访问权限或平台限制。');
  const data = object(envelope.data), main = object(data.main);
  if (!Array.isArray(data.friend_data)) throw new QQError('response', '空间主页动态结构发生变化，未开放互动。');
  const result = parseFeeds(JSON.stringify({ code: 0, data: { main: {}, data: data.friend_data } }), accountId, count);
  const more = main.hasMoreFeeds_0 === true || main.hasMoreFeeds_0 === 1 || main.hasMoreFeeds_0 === '1';
  const offset = typeof main.offset === 'number' || typeof main.offset === 'string' && /^\d{1,7}$/.test(main.offset) ? Number(main.offset) : NaN;
  const hasMore = more && Number.isSafeInteger(offset) && offset > start && offset <= 1000000;
  return { ...result, hasMore, cursor: hasMore ? 'start=' + offset : '' };
}
export function parseFeeds(raw: string, accountId: string, count: number) {
  const envelope = responseObject(raw);
  if (!successful(envelope)) throw new QQError('qzone_auth', '空间未返回可用动态，请检查登录、空间访问权限或平台限制。');
  const data = object(envelope.data), main = object(data.main);
  if (!Array.isArray(data.data)) throw new QQError('response', '空间动态结构发生变化，未开放互动。');
  const posts: ParsedPost[] = []; let skipped = 0;
  const diagnostics = { items: data.data.length, missingHTML: 0, blocks: 0, markers: 0, ambiguous: 0, missingApp: 0, nonPost: 0, invalidCoordinates: 0, unmatched: 0 };
  const seen = new Set<string>();
  for (const rawItem of data.data.slice(0, 100)) {
    const item = object(rawItem);
    if (typeof item.html !== 'string') { skipped++; diagnostics.missingHTML++; continue; }
    const root = parseFragment(item.html.replace(/\\x22/gi, '"').replace(/\\x3c/gi, '<').replace(/\\\//g, '/'));
    const all = nodes(root);
    diagnostics.markers += all.filter(n => attr(n, 'name') === 'feed_data').length;
    let blocks = all.filter(n => /^feed_\d+_\d+_\d+_/.test(attr(n, 'id')));
    if (!blocks.length) blocks = all.filter(n => cls(n, 'f-single'));
    if (!blocks.length && all.some(n => attr(n, 'name') === 'feed_data')) blocks = [root];
    diagnostics.blocks += blocks.length; if (!blocks.length) diagnostics.unmatched++;
    for (const anchor of blocks) {
      // The feed-ID div can contain only the post body. Comments belong to the
      // containing f-single card (or this single-feed JSON item), not that div.
      let block = anchor;
      for (let parent: Node | null = ('parentNode' in anchor ? anchor.parentNode : null); parent; parent = 'parentNode' in parent ? parent.parentNode : null) {
        if (cls(parent, 'f-single')) { block = parent; break; }
      }
      if (block === anchor && blocks.length === 1 && all.filter(n => attr(n, 'name') === 'feed_data').length === 1) block = root;
      const list = nodes(block), markers = list.filter(n => attr(n, 'name') === 'feed_data');
      const m = /^feed_(\d+)_(\d+)_(\d+)_(\d+)_/.exec(attr(anchor, 'id') || String(item.key ?? ''));
      if (markers.length !== 1) { skipped++; diagnostics.ambiguous++; continue; }
      const marker = markers[0], appId = m?.[2] || attr(marker, 'data-appid');
      if (appId !== '311') { skipped++; if (!appId) diagnostics.missingApp++; else diagnostics.nonPost++; continue; }
      const authorId = m?.[1] || String(item.opuin ?? '') || attr(marker, 'data-uin');
      let tid = attr(marker, 'data-tid');
      if (!tid || /^\d+$/.test(tid)) tid = attr(marker, 'data-fkey') || attr(anchor, 'data-key') || tid;
      if (!validUin(authorId) || !validId(tid) || seen.has(authorId + '/' + tid)) { skipped++; diagnostics.invalidCoordinates++; continue; }
      const typeId = m?.[3] || attr(marker, 'data-typeid');
      const origTid = attr(marker, 'data-origtid'), origUin = attr(marker, 'data-origuin');
      const repost = typeId === '5' || (!!origTid && origTid !== tid && origTid !== attr(marker, 'data-tid')) || (!!origUin && origUin !== authorId && origUin !== '0');
      const kind = repost ? 'repost' : typeId === '0' ? 'original' : 'unknown';
      // Conflicting author evidence is readable, but must not be used to target an action.
      const displayed = list.find(n => cls(n, 'f-nick'));
      const displayUin = displayed && nodes(displayed).map(n => /^nameCard_(\d+)$/.exec(attr(n, 'link'))?.[1]).find(Boolean);
      const markerUin = attr(marker, 'data-uin');
      const interactive = (!displayUin || displayUin === authorId) && (!markerUin || markerUin === authorId) && ['0', '5'].includes(typeId);
      const comments = list.filter(n => cls(n, 'comments-item')).slice(0, 30).flatMap(n => {
        const id = attr(n, 'data-tid'), authorId = attr(n, 'data-uin');
        if (!validId(id) || !validUin(authorId)) return [];
        const replyable = attr(n, 'data-type') === 'commentroot';
        const body = nodes(n).find(x => cls(x, 'comments-content'));
        let content = clean(body, 2000, node => cls(node, 'comments-op') || cls(node, 'mod-comments-sub'));
        const nick = body ? clean(nodes(body).find(x => cls(x, 'nickname')), 128) : '';
        if (nick && content.startsWith(nick)) content = content.slice(nick.length).replace(/^\s*[:：]\s*/, '').trim();
        return [{ id, authorId, replyable, text: content }];
      });
      // Duplicate comment coordinates are ambiguous, so replies fail closed.
      for (const c of comments) if (comments.filter(x => x.id === c.id && x.authorId === c.authorId).length !== 1) c.replyable = false;
      const images = [...new Set(list.filter(n => n.nodeName === 'img' && !cls(n, 'user-avatar')).flatMap(n => {
        const url = imageUrl(attr(n, 'truesrc') || attr(n, 'src')); return url ? [url] : [];
      }))].slice(0, 8);
      const info = list.filter(n => cls(n, 'f-info'));
      const contents = info.length ? info : list.filter(n => cls(n, 'txt-box') || cls(n, 'txt-box-title'));
      // The platform's native HTML supplies url3 / data-v_vidioswfurl. Never
      // treat poster, thumbnail, arbitrary links or embedded player URLs as video.
      const videos = [...new Set(list.flatMap(n => {
        if (attr(n, 'data-v_source_website')) return [];
        const candidates = n.nodeName === 'video' ? [attr(n, 'src')]
          : n.nodeName === 'source' && 'parentNode' in n && n.parentNode?.nodeName === 'video' ? [attr(n, 'src')]
          : cls(n, 'f-video-wrap') ? (nodes(n).some(c => !!attr(c, 'data-v_source_website')) ? [] : [attr(n, 'url3')])
          : attr(n, 'data-type') === 'video' ? [attr(n, 'data-v_vidioswfurl'), attr(n, 'data-v_vidiourl')] : [];
        return candidates.flatMap(raw => { const url = videoUrl(raw); return url ? [url] : []; });
      }))].slice(0, 8);
      posts.push({ accountId, authorId, tid, kind, interactive, typeId, timestamp: m?.[4] || attr(marker, 'data-abstime'),
        text: contents.map(n => clean(n)).join('\n').slice(0, 10000), images, videos,
        hasVideo: videos.length > 0 || list.some(n => n.nodeName === 'video' || /video|vid/.test(attr(n, 'class')) || !!attr(n, 'data-vid')),
        comments });
      seen.add(authorId + '/' + tid);
      if (posts.length >= count) break;
    }
    if (posts.length >= count) break;
  }
  const cursor = typeof main.externparam === 'string' && main.externparam.length <= 4096 ? main.externparam : '';
  const hasMore = main.hasMoreFeeds === true || main.hasMoreFeeds === 1 || main.hasMoreFeeds === '1';
  return { posts, cursor: hasMore ? cursor : '', hasMore, skipped, diagnostics };
}
