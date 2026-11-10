/*! Copyright (c) 2026 iinukami and contributors.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */
import type { Context } from 'whalelife';
import { account, id, object, QQError, type Config } from './config.ts';
import { digest } from './messages.ts';

export interface MiniAppKey { userId: string; actionId: string; sessionId: string; }
export interface MiniAppShare extends MiniAppKey {
  personaId?: string; preset: 'bili'; title: string; description: string;
  previewUrl: string; jumpPath: string; webUrl: string;
}
export interface MiniAppOptions { signal?: AbortSignal; permission: 'full'; }
const messages = {
  invalid_input: '小程序分享参数无效。', permission: '小程序分享需要完整发送权限。',
  recipient: '收件人不在 QQ 白名单内或为自身账号。', session: '分享所属会话不可用。',
  binding: '该好友正在处理另一会话的来信，本次未发送。', offline: 'QQ 连接尚未开启。',
  busy: '小程序分享队列已满，本次未提交。', cancelled: '小程序分享已取消，本次未发送。',
  conflict: '同一动作 ID 的分享内容发生变化，已拒绝。', storage: '分享回执保存或读取失败，禁止盲目重发。',
  unsupported: '协议端未能生成小程序卡片，本次未发送。', invalid_card: '协议端返回的卡片不符合请求，本次未发送。',
  uncertain: '平台未确认发送结果，请核对；不会自动重发。',
} as const;
type ErrorCode = keyof typeof messages;
export interface MiniAppReceipt {
  status: 'sent' | 'not_sent' | 'uncertain' | 'not_found'; confirmed: boolean; duplicate: boolean;
  retryAutomatically: false; canRetry: false; platformMessageId?: string; ledgerSaved?: boolean;
  error?: ErrorCode;
}
type Ledger = {
  version: 1; key: string; fingerprint: string; state: 'not_sent' | 'pending' | 'uncertain' | 'sent';
  platformMessageId?: string; error?: ErrorCode;
};
type Submit = (userId: string, ark: string, signal: AbortSignal,
  pending: () => Promise<void>, dispatched: () => void) => Promise<string>;
type PrepareArk = (params: Record<string, unknown>, signal: AbortSignal) => Promise<Record<string, unknown>>;
const hash = /^[a-f0-9]{64}$/;

export function miniAppFailure(code: ErrorCode, status: 'not_sent' | 'uncertain' = 'not_sent'): MiniAppReceipt {
  return { status, confirmed: false, duplicate: false, retryAutomatically: false, canRetry: false,
    error: code };
}
function failureCode(error: unknown, fallback: ErrorCode, signal?: AbortSignal): ErrorCode {
  if (signal?.aborted) return 'cancelled';
  return error instanceof QQError && Object.hasOwn(messages, error.code) ? error.code as ErrorCode : fallback;
}
function fail(code: ErrorCode): never { throw new QQError(code, messages[code]); }
function keys(value: unknown, allowed: string[]) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(k => !allowed.includes(k))) fail('invalid_input');
}
function text(value: unknown, max: number, empty = false): asserts value is string {
  if (typeof value !== 'string' || value.length > max || (!empty && !value.trim()) || /[\u0000-\u001f\u007f]/.test(value)) fail('invalid_input');
}
function https(value: unknown): URL {
  text(value, 2048);
  let url: URL; try { url = new URL(value); } catch { return fail('invalid_input'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash) fail('invalid_input');
  return url;
}
function shareKey(input: MiniAppKey, config: Config) {
  if (typeof input.userId !== 'string' || !/^[1-9]\d{4,19}$/.test(input.userId)
    || typeof input.actionId !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/.test(input.actionId)) fail('invalid_input');
  text(input.sessionId, 200);
  const userId = account(input.userId);
  if (!config.allowedUsers.includes(userId) || userId === config.accountId) fail('recipient');
  return digest([config.accountId, input.sessionId, userId, input.actionId]);
}
function validate(input: MiniAppShare, config: Config, options: MiniAppOptions) {
  keys(input, ['userId', 'actionId', 'sessionId', 'personaId', 'preset', 'title', 'description', 'previewUrl', 'jumpPath', 'webUrl']);
  keys(options, ['permission', 'signal']);
  if (options.permission !== 'full' || config.permission !== 'full') fail('permission');
  const key = shareKey(input, config);
  if (input.personaId !== undefined) text(input.personaId, 200);
  if (input.preset !== 'bili') fail('invalid_input');
  text(input.title, 200); text(input.description, 500, true);
  const preview = https(input.previewUrl), web = https(input.webUrl);
  if (!(preview.hostname === 'hdslb.com' || preview.hostname.endsWith('.hdslb.com'))
    || web.hostname !== 'www.bilibili.com' || web.search || !/^\/video\/BV[1-9A-HJ-NP-Za-km-z]{10}\/$/.test(web.pathname)
    || typeof input.jumpPath !== 'string' || !/^pages\/video\/video\?avid=[1-9]\d{0,19}$/.test(input.jumpPath)) fail('invalid_input');
  const fingerprint = digest([input.personaId ?? '', input.preset, input.title, input.description, input.previewUrl, input.jumpPath, input.webUrl]);
  return { key, fingerprint };
}
function signedArk(value: Record<string, unknown>, input: MiniAppShare): string {
  // The full signed payload is returned by QQ. Validate its identity and target,
  // then preserve every field, including token/ctime, without editing it.
  const ark = object(value.data), config = object(ark.config), detail = object(object(ark.meta).detail_1);
  if (ark.app !== 'com.tencent.miniapp_01' || typeof config.token !== 'string' || !config.token || config.token.length > 8192
    || String(detail.appid) !== '1109937557' || detail.url !== input.jumpPath) fail('invalid_card');
  let serialized: string; try { serialized = JSON.stringify(ark); } catch { return fail('invalid_card'); }
  if (Buffer.byteLength(serialized) > 64 * 1024) fail('invalid_card');
  return serialized;
}
function receipt(ledger: Ledger, duplicate = false, ledgerSaved = true): MiniAppReceipt {
  const status = ledger.state === 'pending' ? 'uncertain' : ledger.state;
  const code = ledger.error ?? (status === 'uncertain' ? 'uncertain' : undefined);
  return { status, confirmed: status === 'sent', duplicate, retryAutomatically: false, canRetry: false, ledgerSaved,
    ...(ledger.platformMessageId ? { platformMessageId: ledger.platformMessageId } : {}),
    ...(code ? { error: code } : {}) };
}

/** Called only by QQRuntime's shared outbound queue. No payload is persisted. */
export class OutboundMiniApp {
  private ctx: Context;
  private config: Config;
  private prepareArk: PrepareArk;
  private submit: Submit;
  private cache = new Map<string, { ledger: Ledger; saved: boolean }>();
  constructor(ctx: Context, config: Config, prepareArk: PrepareArk, submit: Submit) {
    this.ctx = ctx; this.config = config; this.prepareArk = prepareArk; this.submit = submit;
  }
  private remember(ledger: Ledger, saved: boolean) {
    this.cache.set(ledger.key, { ledger, saved });
    if (this.cache.size > 128) this.cache.delete(this.cache.keys().next().value!);
  }
  private async read(key: string) {
    const cached = this.cache.get(key); if (cached) return cached;
    let raw: Record<string, unknown>;
    try {
      const value: unknown = await this.ctx.config.read(`miniapp-delivery-${key}.json`);
      if (!value || typeof value !== 'object' || Array.isArray(value)) fail('storage');
      raw = value as Record<string, unknown>;
    } catch { return fail('storage'); }
    if (!Object.keys(raw).length) return undefined;
    const allowed = ['version', 'key', 'fingerprint', 'state', 'platformMessageId', 'error'];
    if (Object.keys(raw).some(k => !allowed.includes(k)) || raw.version !== 1 || raw.key !== key || typeof raw.fingerprint !== 'string' || !hash.test(raw.fingerprint)
      || !['not_sent', 'pending', 'uncertain', 'sent'].includes(String(raw.state))
      || (raw.error !== undefined && !Object.hasOwn(messages, String(raw.error)))) fail('storage');
    if (raw.state === 'sent') {
      try { if (typeof raw.platformMessageId !== 'string' || id(raw.platformMessageId) === '0') fail('storage'); } catch { return fail('storage'); }
    } else if (raw.platformMessageId !== undefined) fail('storage');
    const ledger = raw as unknown as Ledger;
    this.remember(ledger, true); return { ledger, saved: true };
  }
  private async save(ledger: Ledger) {
    this.remember(ledger, false);
    try { await this.ctx.config.save(`miniapp-delivery-${ledger.key}.json`, ledger); }
    catch { return fail('storage'); }
    this.remember(ledger, true);
  }
  private async session(input: MiniAppKey & { personaId?: string }, signal: AbortSignal) {
    signal.throwIfAborted();
    try {
      // context() can describe a syntactically valid but absent ID. Existence
      // must come from the public list, not from a successful context lookup.
      const sessions = await this.ctx.sessions.list(); signal.throwIfAborted();
      if (!sessions.some(session => session.id === input.sessionId)) fail('session');
      await this.ctx.sessions.context(input.sessionId, input.personaId ?? this.config.personaId);
    } catch { return fail('session'); }
    signal.throwIfAborted();
  }
  async status(input: MiniAppKey, signal: AbortSignal): Promise<MiniAppReceipt> {
    try {
      keys(input, ['userId', 'actionId', 'sessionId']);
      const key = shareKey(input, this.config); await this.session(input, signal);
      const found = await this.read(key); signal.throwIfAborted();
      return found ? receipt(found.ledger, true, found.saved)
        : { status: 'not_found', confirmed: false, duplicate: false, retryAutomatically: false, canRetry: false };
    } catch (error) {
      const code = failureCode(error, 'storage', signal);
      return miniAppFailure(code, code === 'storage' ? 'uncertain' : 'not_sent');
    }
  }
  async execute(input: MiniAppShare, options: MiniAppOptions, signal: AbortSignal, beforePrepare: () => Promise<void>): Promise<MiniAppReceipt> {
    let ledger: Ledger | undefined, dispatched = false;
    try {
      signal.throwIfAborted();
      const { key, fingerprint } = validate(input, this.config, options);
      await this.session(input, signal);
      const previous = await this.read(key); signal.throwIfAborted();
      if (previous) {
        if (previous.ledger.fingerprint !== fingerprint) fail('conflict');
        return receipt(previous.ledger, true, previous.saved);
      }
      // Reserve the operation before any protocol call. Even a signing failure is
      // final for this action ID; callers must never use receipt lookup as retry.
      ledger = { version: 1, key, fingerprint, state: 'not_sent' };
      await this.save(ledger); signal.throwIfAborted();
      await beforePrepare(); signal.throwIfAborted();
      let value: Record<string, unknown>;
      try {
        value = await this.prepareArk({ type: 'bili', title: input.title, desc: input.description,
          picUrl: input.previewUrl, jumpUrl: input.jumpPath, webUrl: input.webUrl }, signal);
      } catch (error) { throw new QQError(failureCode(error, 'unsupported', signal), messages.unsupported); }
      signal.throwIfAborted();
      const ark = signedArk(value, input);
      const platformId = await this.submit(input.userId, ark, signal, async () => {
        await beforePrepare(); signal.throwIfAborted();
        await this.session(input, signal);
        ledger!.state = 'pending'; await this.save(ledger!); signal.throwIfAborted();
        await beforePrepare(); signal.throwIfAborted();
      }, () => { dispatched = true; });
      let messageId: string;
      try { messageId = id(platformId); if (messageId === '0') fail('uncertain'); } catch { return this.failed(ledger, 'uncertain', true); }
      // A confirmed external action is irreversible. Cancellation/persistence
      // failures afterwards cannot turn it into a claimed failed send.
      ledger.state = 'sent'; ledger.platformMessageId = messageId; delete ledger.error;
      let saved = true; try { await this.save(ledger); } catch { saved = false; }
      try {
        await this.ctx.memory.recordExperience(input.sessionId, { event_id: `qq-miniapp:${key}`, outcome: 'succeeded',
          text: '已通过 QQ 私聊发送一张 B 站视频小程序卡片。', origin: { platform: 'QQ 私聊', action: '分享小程序卡片' } });
      } catch { /* Fixed success fact is best effort; never resend for memory. */ }
      const result = receipt(ledger, false, saved);
      if (!saved) result.error = 'storage';
      return result;
    } catch (error) {
      const uncertain = dispatched && !(error instanceof QQError && error.notSent);
      const code = uncertain ? 'uncertain' : failureCode(error, 'invalid_input', signal);
      if (!ledger) return miniAppFailure(code, uncertain || code === 'storage' ? 'uncertain' : 'not_sent');
      return this.failed(ledger, code, uncertain);
    }
  }
  private async failed(ledger: Ledger, code: ErrorCode, uncertain: boolean) {
    ledger.state = uncertain ? 'uncertain' : 'not_sent'; ledger.error = code;
    let saved = true; try { await this.save(ledger); } catch { saved = false; }
    return receipt(ledger, false, saved);
  }
}
