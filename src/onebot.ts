/*! Copyright (c) 2026 iinukami and contributors.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */
import WebSocket from 'ws';
import { randomUUID } from 'node:crypto';
import { object, account, QQError, type Config } from './config.ts';

type Pending = { resolve(value: unknown): void; reject(error: Error): void; dispose(): void; plainText: boolean };
const desktopUnavailable = '桌面 QQ 接入不可用（账号离线或身份校验未通过），正在等待同账号恢复并重新核验。';
function platformError(value: Record<string, unknown>, guardedText = false) {
  const code = Number.isSafeInteger(value.retcode) ? `（错误码 ${value.retcode}）` : '';
  // Only our fixed diagnostic codes are reflected. Arbitrary protocol messages
  // can contain message text, URLs, credentials or native stack traces.
  const detail = [value.message, value.wording].includes('selected_account_offline') ? desktopUnavailable : '协议端报告操作失败。';
  return new QQError(value.status === 'failed' ? 'platform_failed' : 'uncertain',
    value.status === 'failed' ? detail + code : '协议端未确认完成，结果不确定，请核对，勿重复发送。' + code,
    // In the bundled native plain-text path this exact guard throws before sendMsg.
    // Do not generalize to media, external protocols or arbitrary failed envelopes.
    guardedText && value.status === 'failed' && value.retcode === 1200 &&
      [value.message, value.wording].includes('selected_account_offline'));
}
export interface LinkState { state: 'disconnected' | 'connecting' | 'online' | 'stopped'; error?: string; }
export class OneBot {
  private socket?: WebSocket;
  private timer?: ReturnType<typeof setTimeout>;
  private ping?: ReturnType<typeof setInterval>;
  private pending = new Map<string, Pending>();
  private attempt = 0;
  private online = false;
  private stopped = false;
  private checkingDesktop = false;
  private signal: AbortSignal;
  private config: Config;
  private onEvent: (event: Record<string, unknown>) => void;
  private onState: (state: LinkState) => void;
  constructor(config: Config, signal: AbortSignal, onEvent: (event: Record<string, unknown>) => void, onState: (state: LinkState) => void) {
    this.config = config; this.signal = signal; this.onEvent = onEvent; this.onState = onState;
    signal.addEventListener('abort', this.stop, { once: true });
  }
  start() { if (this.signal.aborted) this.stop(); else this.connect(); }
  private connect() {
    if (this.stopped || this.signal.aborted) return;
    this.onState({ state: 'connecting' });
    const ws = new WebSocket(this.config.wsUrl, {
      headers: this.config.accessToken ? { Authorization: `Bearer ${this.config.accessToken}` } : {},
      handshakeTimeout: this.config.requestTimeoutMs, maxPayload: 36 * 1024 * 1024,
      followRedirects: false, perMessageDeflate: false,
    });
    this.socket = ws;
    ws.on('error', () => { /* close drives bounded reconnect; never log URLs or tokens */ });
    ws.on('message', bytes => {
      if (this.socket !== ws || this.stopped) return;
      let value: Record<string, unknown>;
      try { value = object(JSON.parse(bytes.toString())); } catch { return; }
      if (typeof value.echo === 'string' && this.pending.has(value.echo)) {
        const call = this.pending.get(value.echo)!;
        this.pending.delete(value.echo); call.dispose();
        if (value.status === 'ok' && value.retcode === 0) call.resolve(value.data);
        else {
          if (this.config.connectionMode === 'attach' && [value.message, value.wording].includes('selected_account_offline')) {
            this.online = false; this.onState({ state: 'disconnected', error: desktopUnavailable });
          }
          call.reject(platformError(value, this.config.connectionMode === 'attach' && call.plainText));
        }
      } else if (this.online && (value.post_type === 'message' ||
        (value.post_type === 'notice' && value.notice_type === 'notify' && value.sub_type === 'poke' && value.group_id)) &&
        Buffer.byteLength(bytes.toString()) <= 256 * 1024) {
        try { this.onEvent(value); } catch { /* callback boundary */ }
      }
    });
    ws.once('open', () => { void this.authenticate(ws).catch(() => { if (this.socket === ws) ws.terminate(); }); });
    ws.once('close', () => {
      if (this.socket !== ws) return;
      this.online = false; this.socket = undefined;
      if (this.ping) clearInterval(this.ping);
      this.ping = undefined;
      this.rejectPending(new QQError('disconnected', '连接已断开；已提交操作的结果可能不确定。'));
      if (this.stopped || this.signal.aborted) return;
      this.onState({ state: 'disconnected', error: '协议端未连接，正在等待重连。' });
      const delay = Math.min(this.config.reconnectMaxMs, 1000 * 2 ** Math.min(this.attempt++, 7));
      this.timer = setTimeout(() => { this.timer = undefined; this.connect(); }, delay);
      this.timer.unref();
    });
  }
  private async authenticate(ws: WebSocket) {
    const login = await this.request('get_login_info', {}, this.signal, true);
    if (account(login.user_id) !== this.config.accountId) {
      this.stop(); this.onState({ state: 'stopped', error: '登录账号与配置不符，已停止连接。' }); return;
    }
    if (this.socket !== ws || this.stopped || this.signal.aborted) return;
    this.attempt = 0;
    if (this.config.connectionMode === 'attach') await this.checkDesktop(ws);
    else { this.online = true; this.onState({ state: 'online' }); }
    if (this.socket !== ws || this.stopped || this.signal.aborted) return;
    let pong = true;
    ws.on('pong', () => { pong = true; });
    this.ping = setInterval(() => {
      if (!pong) { ws.terminate(); return; }
      pong = false; if (ws.readyState === WebSocket.OPEN) ws.ping();
      if (this.config.connectionMode === 'attach') void this.checkDesktop(ws);
    }, 15000);
    this.ping.unref();
  }
  private async checkDesktop(ws: WebSocket) {
    if (this.checkingDesktop || this.socket !== ws || this.stopped) return;
    this.checkingDesktop = true;
    try {
      // get_status/get_login_info use cached NapCat data. This read-only action
      // actually crosses our native session guard; never retry an external send.
      await this.request('get_friend_list', {}, this.signal, true);
      if (this.socket === ws && !this.stopped && !this.signal.aborted) {
        this.online = true; this.onState({ state: 'online' });
      }
    } catch (e) {
      if (this.socket === ws && !this.stopped && !this.signal.aborted) {
        this.online = false;
        this.onState({ state: 'disconnected', error: e instanceof QQError ? e.message : '桌面 QQ 接入核验未完成。' });
      }
    } finally { this.checkingDesktop = false; }
  }
  request(action: 'get_friend_list' | 'get_group_list' | 'get_group_member_list', params: Record<string, unknown>, signal: AbortSignal): Promise<unknown[]>;
  request(action: string, params: Record<string, unknown>, signal: AbortSignal, handshake?: boolean, timeoutMs?: number): Promise<Record<string, unknown>>;
  request(action: string, params: Record<string, unknown>, signal: AbortSignal, handshake = false, timeoutMs = this.config.requestTimeoutMs): Promise<Record<string, unknown> | unknown[]> {
    if (signal.aborted || this.signal.aborted) throw new QQError('cancelled', '操作在提交前已取消。', true);
    const ws = this.socket;
    if (this.stopped || !ws || ws.readyState !== WebSocket.OPEN || (!this.online && !handshake))
      return Promise.reject(new QQError('offline', 'QQ 协议端尚未连接。', true));
    if (this.pending.size >= 64) return Promise.reject(new QQError('busy', '请求过多，请稍后重试。', true));
    const echo = randomUUID();
    return new Promise((resolve, reject) => {
      const done = (error: Error) => {
        const call = this.pending.get(echo); if (!call) return;
        this.pending.delete(echo); call.dispose(); reject(error);
      };
      const abort = () => done(new QQError('cancelled', '操作已取消，已提交的外部动作需核对。'));
      const timer = setTimeout(() => done(new QQError('timeout', '协议端响应超时，结果可能不确定。')), timeoutMs);
      timer.unref();
      this.pending.set(echo, { plainText: action === 'send_private_msg' && params.auto_escape === true && Array.isArray(params.message) &&
          params.message.length > 0 && params.message.every(p => object(p).type === 'text'),
        resolve: value => {
          if (action === 'get_group_list' || action === 'get_group_member_list') {
            if (Array.isArray(value)) resolve(value);
            else reject(new QQError('group_response', '群查询回执格式无效。'));
          } else resolve(action === 'get_friend_list' ? (Array.isArray(value) ? value : []) : object(value));
        },
        reject, dispose: () => { clearTimeout(timer); signal.removeEventListener('abort', abort); } });
      signal.addEventListener('abort', abort, { once: true });
      ws.send(JSON.stringify({ action, params, echo }), error => {
        if (error) done(new QQError('disconnected', '发送请求时连接中断，结果可能不确定。'));
      });
    });
  }
  private rejectPending(error: Error) {
    for (const call of this.pending.values()) { call.dispose(); call.reject(error); }
    this.pending.clear();
  }
  stop = () => {
    if (this.stopped) return;
    this.stopped = true; this.online = false;
    this.signal.removeEventListener('abort', this.stop);
    if (this.timer) clearTimeout(this.timer);
    if (this.ping) clearInterval(this.ping);
    this.timer = undefined; this.ping = undefined;
    this.rejectPending(new QQError('cancelled', 'QQ 插件已停止。'));
    this.socket?.terminate(); this.socket = undefined;
    this.onState({ state: 'stopped' });
  };
}
