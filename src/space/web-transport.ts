import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import sharp from 'sharp';
import { fetch as httpFetch } from 'undici';
import { account, object, QQError } from '../config.ts';
import type { OneBot } from '../onebot.ts';
import { sessionId } from './policy.ts';
import { imageUrl, parseFeeds, parseProfileFeeds, responseObject, successful, type ParsedPost } from './feeds.ts';
import type { BrowseInput, BrowseResult, Interaction, PostTarget, SocialTransportReceipt } from './types.ts';

type Capability = { sessionId: string; accountId: string; expires: number } & (
  { kind: 'post'; post: PostTarget; images: string[] } | { kind: 'cursor'; value: string; authorId?: string; source?: 'feed' | 'profile' });
const LIMIT = 4 * 1024 * 1024;
/** Parent-only authenticated transport. No files, caches, arbitrary URLs, retries or credentials in results. */
export class SpaceWebTransport {
  private key = randomBytes(32);
  private bot: Pick<OneBot, 'request'>;
  private signal: AbortSignal;
  private identity: () => { accountId: string; online: boolean };
  private fetch: typeof httpFetch;
  private busy = false;
  constructor(bot: Pick<OneBot, 'request'>, signal: AbortSignal, identity: SpaceWebTransport['identity'], fetch = httpFetch) {
    this.bot = bot; this.signal = signal; this.identity = identity; this.fetch = fetch;
  }
  private seal(v: Capability) {
    const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const bytes = Buffer.concat([cipher.update(JSON.stringify(v), 'utf8'), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), bytes]).toString('base64url');
  }
  private open(ref: string, sid: string): Capability {
    try {
      if (typeof ref !== 'string' || !/^[\w-]{40,65536}$/.test(ref)) throw Error();
      const bytes = Buffer.from(ref, 'base64url'), decipher = createDecipheriv('aes-256-gcm', this.key, bytes.subarray(0, 12));
      decipher.setAuthTag(bytes.subarray(12, 28));
      const v = JSON.parse(Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString('utf8')) as Capability;
      const current = this.identity();
      if (!current.online || v.accountId !== current.accountId || v.sessionId !== sessionId(sid) || v.expires < Date.now()) throw Error();
      return v;
    } catch { throw new QQError('reference', '动态引用已过期、账号已变化或不属于本会话，请重新浏览。'); }
  }
  resolve(input: { sessionId: string; ref: string }, options: { signal: AbortSignal }): PostTarget {
    this.signal.throwIfAborted(); options.signal.throwIfAborted();
    const v = this.open(input.ref, input.sessionId);
    if (v.kind !== 'post') throw new QQError('reference', '需要动态引用。');
    return v.post;
  }
  private async auth(signal: AbortSignal) {
    signal.throwIfAborted(); const current = this.identity();
    if (!current.online) throw new QQError('offline', 'QQ 不在线，未访问空间。');
    const v = await this.bot.request('get_cookies', { domain: 'qzone.qq.com' }, signal);
    signal.throwIfAborted();
    if (typeof v.cookies !== 'string' || v.cookies.length > 32768 || /[\r\n]/.test(v.cookies)) throw new QQError('auth', 'QQ 未提供可用的空间登录态。');
    const cookies = new Map<string, string>(v.cookies.split(';').map((s: string) => { const i = s.indexOf('='); return [s.slice(0, i).trim(), s.slice(i + 1).trim()]; }));
    const uin = (cookies.get('p_uin') || cookies.get('uin') || '').replace(/^o0*/, '');
    const skey = cookies.get('p_skey') || cookies.get('skey');
    if (!skey || uin !== current.accountId || this.identity().accountId !== current.accountId) throw new QQError('auth', '空间登录态与当前 QQ 账号不一致。');
    let gtk = 5381; for (let i = 0; i < skey.length; i++) gtk += (gtk << 5) + skey.charCodeAt(i);
    return { accountId: current.accountId, cookie: v.cookies as string, gtk: String(gtk & 0x7fffffff) };
  }
  private async bytes(response: Awaited<ReturnType<typeof httpFetch>>, limit: number, signal: AbortSignal) {
    if (!response.ok || !response.body || Number(response.headers.get('content-length')) > limit) {
      await response.body?.cancel(); throw new QQError('http', '空间服务请求失败或响应过大。');
    }
    const chunks: Buffer[] = []; let size = 0;
    for await (const c of response.body) {
      signal.throwIfAborted(); size += c.byteLength;
      if (size > limit) throw new QQError('size', '空间响应超过读取上限。');
      chunks.push(Buffer.from(c));
    }
    return Buffer.concat(chunks);
  }
  private async request(path: string, params: Record<string, string>, auth: Awaited<ReturnType<SpaceWebTransport['auth']>>, signal: AbortSignal, method: 'GET' | 'POST') {
    signal.throwIfAborted();
    if (!this.identity().online || this.identity().accountId !== auth.accountId) throw new QQError('identity', 'QQ 账号或连接已变化。');
    const query = new URLSearchParams(method === 'GET' ? { ...params, g_tk: auth.gtk } : { g_tk: auth.gtk });
    const r = await this.fetch('https://user.qzone.qq.com/proxy/domain/' + path + '?' + query, {
      method, signal, redirect: 'error', ...(method === 'POST' ? { body: new URLSearchParams(params) } : {}),
      headers: { Cookie: auth.cookie, Referer: `https://user.qzone.qq.com/${auth.accountId}/main`,
        'User-Agent': 'Mozilla/5.0', ...(method === 'POST' ? { 'Content-Type': 'application/x-www-form-urlencoded', Origin: 'https://user.qzone.qq.com' } : {}) },
    });
    return (await this.bytes(r, LIMIT, signal)).toString('utf8');
  }
  async browse(input: BrowseInput, options: { signal: AbortSignal }): Promise<BrowseResult> {
    const signal = AbortSignal.any([this.signal, options.signal, AbortSignal.timeout(30000)]), sid = sessionId(input.sessionId);
    const authorId = input.authorId === undefined ? undefined : account(input.authorId);
    const count = input.count ?? 10;
    if (!Number.isInteger(count) || count < 1 || count > 20) throw new QQError('input', '每次读取 1–20 条动态。');
    let cursor = '', source: 'feed' | 'profile' | undefined;
    if (input.cursor) {
      const c = this.open(input.cursor, sid);
      if (c.kind !== 'cursor' || c.authorId !== authorId) throw new QQError('reference', '翻页引用与浏览范围不一致。');
      cursor = c.value; source = c.source ?? 'feed';
    }
    const auth = await this.auth(signal), page = new URLSearchParams(cursor);
    source ??= authorId && authorId !== auth.accountId ? 'profile' : 'feed';
    const start = Number(page.get('start') ?? '0');
    if (source === 'profile' && (!authorId || !Number.isSafeInteger(start) || start < 0 || start > 1000000)) throw new QQError('reference', '空间主页翻页引用无效。');
    const raw = source === 'profile' ? await this.request('ic2.qzone.qq.com/cgi-bin/feeds/feeds_html_act_all', {
      uin: authorId!, hostuin: authorId!, scope: '0', filter: 'all', flag: '1', refresh: '0', firstGetGroup: '0', mixnocache: '0', scene: '0',
      start: String(start), count: String(count), sidomain: 'qzonestyle.gtimg.cn', useutf8: '1', outputhtmlfeed: '1', refer: '2', r: String(Math.random()),
    }, auth, signal, 'GET') : await this.request('ic2.qzone.qq.com/cgi-bin/feeds/feeds3_html_more', {
      uin: auth.accountId, scope: '0', view: '1', daylist: '', uinlist: authorId ?? '', gid: '', flag: '1',
      filter: 'all', applist: 'all', refresh: cursor ? '0' : '1', pagenum: page.get('pagenum') ?? '1', begintime: page.get('basetime') ?? '',
      dayspac: '5', sidomain: 'qzonestyle.gtimg.cn', useutf8: '1', outputhtmlfeed: '1', format: 'json', count: String(count),
      aisortEndTime: '0', aisortOffset: '0', getAisort: '0', aisortBeginTime: '0', firstGetGroup: '0', icServerTime: '0', mixnocache: '0', scene: '0',
      rd: String(Math.random()), usertime: String(Date.now()), windowId: String(Math.random()), ...(cursor ? { externparam: cursor } : {}),
    }, auth, signal, 'GET');
    const result = source === 'profile' ? parseProfileFeeds(raw, auth.accountId, count, start) : parseFeeds(raw, auth.accountId, count);
    const base = { accountId: auth.accountId, sessionId: sid, expires: Date.now() + 15 * 60000 };
    return { accountId: auth.accountId, posts: result.posts.filter(p => !authorId || p.authorId === authorId).map((p: ParsedPost) => {
      const { images, text, hasVideo, comments, ...meta } = p;
      const post = { ...meta, comments: comments.map(({ text: _text, ...c }) => c) };
      return { accountId: p.accountId, authorId: p.authorId, tid: p.tid, kind: p.kind, interactive: p.interactive,
        text, hasVideo, comments, imageCount: images.length, ref: this.seal({ ...base, kind: 'post', post, images }) };
    }), source, hasMore: result.hasMore, skipped: result.skipped, diagnostics: result.diagnostics,
      ...(result.cursor ? { cursor: this.seal({ ...base, kind: 'cursor', value: result.cursor, authorId, source }) } : {}) };
  }
  async readImage(input: { sessionId: string; ref: string; index: number }, options: { signal: AbortSignal }) {
    const signal = AbortSignal.any([this.signal, options.signal, AbortSignal.timeout(30000)]);
    const v = this.open(input.ref, input.sessionId);
    if (v.kind !== 'post' || !Number.isInteger(input.index) || input.index < 0 || input.index >= v.images.length) throw new QQError('image', '图片序号无效。');
    const url = imageUrl(v.images[input.index]); if (!url) throw new QQError('image', '图片来源不受支持。');
    const response = await this.fetch(url, { signal, redirect: 'error' });
    const bytes = await this.bytes(response, 10 * 1024 * 1024, signal), meta = await sharp(bytes, { limitInputPixels: 40000000 }).metadata();
    if (!['png', 'jpeg', 'gif', 'webp'].includes(meta.format ?? '')) throw new QQError('image', '图片格式不受支持。');
    return { mime: 'image/' + meta.format, base64: bytes.toString('base64') };
  }
  async interact(input: { sessionId: string; ref: string; action: Interaction }, options: { signal: AbortSignal }): Promise<SocialTransportReceipt> {
    if (this.busy) return { status: 'not_submitted' };
    this.busy = true; let submitted = false;
    try {
      const signal = AbortSignal.any([this.signal, options.signal, AbortSignal.timeout(30000)]);
      const post = this.resolve(input, { signal }), a = input.action;
      if (!post.interactive || !['like', 'comment', 'repost'].includes(a.kind) || (a.kind === 'repost' && post.kind !== 'original')
        || (a.text !== undefined && (typeof a.text !== 'string' || a.text.length > 10000 || /@\{|\[CQ:at\b/i.test(a.text)))) throw Error('action');
      if (a.kind === 'like' && (a.text || a.reply || a.mentions?.length)) throw Error('action');
      if (a.reply && (a.kind !== 'comment' || !post.comments.some(c => c.id === a.reply!.commentId && c.authorId === a.reply!.authorId && c.replyable))) throw Error('reply');
      if (a.mentions && (!Array.isArray(a.mentions) || a.mentions.length > 10)) throw Error('mentions');
      const mentions = [...new Set([...(a.reply ? [account(a.reply.authorId)] : []), ...(a.mentions ?? []).map(account)])];
      const content = mentions.map(id => `@{uin:${id},nick:${id},auto:1} `).join('') + (a.text ?? '');
      if (a.kind === 'comment' && !content.trim()) throw Error('empty');
      const auth = await this.auth(signal), qzreferrer = `https://user.qzone.qq.com/${auth.accountId}/main`;
      const common = { format: 'json', qzreferrer }; let path: string, params: Record<string, string>;
      if (a.kind === 'like') {
        const key = `http://user.qzone.qq.com/${post.authorId}/mood/${post.tid}`;
        path = 'w.qzone.qq.com/cgi-bin/likes/internal_dolike_app';
        params = { ...common, opuin: auth.accountId, unikey: key, curkey: key, appid: '311', typeid: post.typeId, fid: post.tid,
          from: '1', active: '0', fupdate: '1', abstime: post.timestamp };
      } else if (a.kind === 'comment') {
        path = 'taotao.qzone.qq.com/cgi-bin/emotion_cgi_re_feeds';
        params = { ...common, hostUin: post.authorId, topicId: `${post.authorId}_${post.tid}`, content,
          ...(a.reply ? { commentId: a.reply.commentId, replyUin: a.reply.authorId, commentUin: a.reply.authorId } : {}) };
      } else {
        path = 'taotao.qzone.qq.com/cgi-bin/emotion_cgi_forward_v6';
        params = { ...common, tid: post.tid, ouin: post.authorId, opuin: auth.accountId, hostUin: post.authorId, topicId: `${post.authorId}_${post.tid}`,
          con: content || '转发', feedversion: '1', ver: '1', code_version: '1', appid: '311', ugc_right: '1' };
      }
      signal.throwIfAborted(); submitted = true;
      const result = responseObject(await this.request(path, params, auth, signal, 'POST'));
      const codes = [result.code, result.ret, result.subcode].filter(v => v !== undefined).map(Number);
      const platformCode = codes.find(c => Number.isSafeInteger(c) && c !== 0) ?? codes.find(Number.isSafeInteger);
      if (!successful(result)) return { status: 'uncertain', reason: 'platform_rejected', ...(platformCode !== undefined ? { platformCode } : {}) };
      const data = object(result.data), rawId = a.kind === 'repost' ? (data.tid ?? result.tid) : (data.commentid ?? data.commentId ?? data.comment_id ?? result.commentid ?? result.commentId ?? result.comment_id);
      const platformId = (typeof rawId === 'number' && Number.isSafeInteger(rawId)) || typeof rawId === 'string' ? String(rawId) : '';
      if (a.kind !== 'like' && (!/^[a-zA-Z0-9_-]{1,128}$/.test(platformId) || platformId === '0')) {
        // Some comment responses acknowledge acceptance without an ID. One read-only
        // verification can establish a newly observed, exact own comment. Never POST
        // again, and never claim success if missing, duplicated or ambiguous.
        if (a.kind === 'comment' && !a.reply && !mentions.length) {
          try {
            const fresh = await this.browse({ sessionId: input.sessionId, authorId: post.authorId, count: 20 }, { signal });
            const current = fresh.posts.find(p => p.tid === post.tid && p.authorId === post.authorId);
            const matches = current?.comments.filter(c => c.replyable && c.authorId === auth.accountId && c.text === content.trim()
              && !post.comments.some(old => old.id === c.id && old.authorId === c.authorId)) ?? [];
            if (matches.length === 1) return { status: 'sent', platformCode: 0, platformId: matches[0].id };
          } catch { /* The POST is not repeated if read-back fails. */ }
        }
        return { status: 'uncertain', platformCode: 0, reason: 'missing_receipt' };
      }
      return { status: 'sent', platformCode: 0, ...(a.kind === 'like' ? {} : { platformId }) };
    } catch (error) { return { status: submitted ? 'uncertain' : 'not_submitted', reason: !submitted ? 'preflight_rejected' : error instanceof QQError && error.code === 'response' ? 'response_format' : 'transport_failed' }; }
    finally { this.busy = false; }
  }
}
