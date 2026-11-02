import WebSocket from 'ws';
import { randomUUID } from 'node:crypto';
import { object, account, QQError, type Config } from './config.ts';

type Pending = { resolve(value: unknown): void; reject(error: Error): void; dispose(): void };
export interface LinkState { state: 'disconnected' | 'connecting' | 'online' | 'stopped'; error?: string; }
export class OneBot {
  private socket?: WebSocket;
  private timer?: ReturnType<typeof setTimeout>;
  private ping?: ReturnType<typeof setInterval>;
  private pending = new Map<string, Pending>();
  private attempt = 0;
  private online = false;
  private stopped = false;
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
        else call.reject(new QQError(value.status === 'failed' ? 'platform_failed' : 'uncertain',
          value.status === 'failed' ? '协议端报告操作失败。' : '协议端未确认完成，结果不确定，请核对，勿重复发送。'));
      } else if (this.online && value.post_type === 'message' && Buffer.byteLength(bytes.toString()) <= 256 * 1024) {
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
    this.online = true; this.attempt = 0;
    this.onState({ state: 'online' });
    let pong = true;
    ws.on('pong', () => { pong = true; });
    this.ping = setInterval(() => {
      if (!pong) { ws.terminate(); return; }
      pong = false; if (ws.readyState === WebSocket.OPEN) ws.ping();
    }, 15000);
    this.ping.unref();
  }
  request(action: 'get_friend_list', params: Record<string, unknown>, signal: AbortSignal): Promise<unknown[]>;
  request(action: string, params: Record<string, unknown>, signal: AbortSignal, handshake?: boolean, timeoutMs?: number): Promise<Record<string, unknown>>;
  request(action: string, params: Record<string, unknown>, signal: AbortSignal, handshake = false, timeoutMs = this.config.requestTimeoutMs): Promise<Record<string, unknown> | unknown[]> {
    signal.throwIfAborted(); this.signal.throwIfAborted();
    const ws = this.socket;
    if (this.stopped || !ws || ws.readyState !== WebSocket.OPEN || (!this.online && !handshake))
      return Promise.reject(new QQError('offline', 'QQ 协议端尚未连接。'));
    if (this.pending.size >= 64) return Promise.reject(new QQError('busy', '请求过多，请稍后重试。'));
    const echo = randomUUID();
    return new Promise((resolve, reject) => {
      const done = (error: Error) => {
        const call = this.pending.get(echo); if (!call) return;
        this.pending.delete(echo); call.dispose(); reject(error);
      };
      const abort = () => done(new QQError('cancelled', '操作已取消，已提交的外部动作需核对。'));
      const timer = setTimeout(() => done(new QQError('timeout', '协议端响应超时，结果可能不确定。')), timeoutMs);
      timer.unref();
      this.pending.set(echo, { resolve: value => resolve(action === 'get_friend_list' ? (Array.isArray(value) ? value : []) : object(value)),
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
