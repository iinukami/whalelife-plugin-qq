/*! Copyright (c) 2026 iinukami and contributors.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import QRCode from 'qrcode';
import { account, object, QQError, type Config } from './config.ts';

export const pluginRoot = dirname(fileURLToPath(import.meta.url));
export interface EngineStatus {
  state: 'stopped' | 'preparing' | 'starting' | 'waiting_login' | 'online' | 'failed';
  name: string; version: string; error: string; qrCode?: string; accountId?: string; loginNotice?: string;
}
export function quoteWindows(value: string) {
  return '"' + value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/g, '$1$1') + '"';
}
export class OwnedProcess {
  private child?: ChildProcessWithoutNullStreams;
  private completion: Promise<void> = Promise.resolve();
  private stopping = false;
  pid?: number;
  private readonly root: string;
  constructor(root: string) { this.root = root; }
  start(exe: string, args: string[], cwd: string, env: Record<string, string>, onExit: () => void) {
    if (process.platform !== 'win32') throw new QQError('platform', '当前托管组件仅支持 Windows x64。');
    const shell = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
    this.child = spawn(shell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', join(this.root, 'managed/windows-job.ps1')], {
      windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], cwd,
    });
    const child = this.child;
    this.completion = new Promise<void>(r => child.once('close', () => { if (!this.stopping) onExit(); r(); }));
    child.on('error', () => { if (!this.stopping) onExit(); });
    child.stdin.on('error', () => {});
    let text = '';
    child.stdout.on('data', chunk => {
      text = (text + chunk.toString()).slice(-8192);
      let end: number;
      while ((end = text.indexOf('\n')) >= 0) {
        const line = text.slice(0, end); text = text.slice(end + 1);
        try { const message = JSON.parse(line); if (message.event === 'started') this.pid = message.pid; } catch {}
      }
    });
    child.stderr.resume(); // Never forward third-party credentials or message content.
    child.stdin.write(JSON.stringify({ exe, commandLine: [exe, ...args].map(quoteWindows).join(' '), cwd, env }) + '\n');
  }
  async stop() {
    if (this.stopping) return this.completion;
    this.stopping = true;
    this.child?.stdin.end('stop\n');
    const timer = setTimeout(() => this.child?.kill(), 800); // Killing supervisor closes its Job handle.
    try { await this.completion; } finally { clearTimeout(timer); }
  }
}
async function freePort(signal: AbortSignal): Promise<number> {
  signal.throwIfAborted();
  const server = createServer();
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = (server.address() as { port: number }).port;
  await new Promise<void>(r => server.close(() => r()));
  signal.throwIfAborted(); return port;
}
export async function verifyEngine(root: string, signal: AbortSignal) {
  const manifest = object(JSON.parse(await readFile(join(root, 'vendor/engine-manifest.json'), 'utf8')));
  if (manifest.version !== '4.18.41' || manifest.platform !== 'win32-x64') throw new QQError('engine_version', '托管组件版本不匹配，请重新安装完整插件包。');
  const files = object(manifest.files);
  for (const required of ['node.exe', 'index.js', 'wrapper.node', 'napcat/napcat.mjs']) if (!files[required]) throw new QQError('engine_missing', '托管组件不完整，请重新安装完整插件包。');
  const base = resolve(root, 'vendor/napcat');
  for (const [relative, expected] of Object.entries(files)) {
    signal.throwIfAborted();
    const file = resolve(base, relative);
    if (!file.startsWith(base + sep) || typeof expected !== 'string') throw new QQError('engine_manifest', '托管组件清单无效。');
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(file, { signal })) hash.update(chunk);
    if (hash.digest('hex') !== expected) throw new QQError('engine_integrity', '托管组件校验失败，请重新安装完整插件包；不会运行损坏的组件。');
  }
}
export class ManagedEngine {
  private controller = new AbortController();
  readonly signal: AbortSignal;
  readonly status: EngineStatus = { state: 'stopped', name: 'NapCat', version: '4.18.41', error: '' };
  private process: OwnedProcess;
  private task?: Promise<void>;
  private base = '';
  private token = '';
  private credential = '';
  private credentialAt = 0;
  private ready = false;
  private qrURL = '';
  private config: Config;
  private onReady: (effective: Config) => void;
  private onFailure: () => void | Promise<void>;
  readonly root: string;
  constructor(config: Config, signal: AbortSignal, onReady: (effective: Config) => void,
    onFailure: () => void | Promise<void>, root = pluginRoot) {
    this.config = config; this.onReady = onReady; this.onFailure = onFailure; this.root = root;
    this.signal = AbortSignal.any([signal, this.controller.signal]);
    this.process = new OwnedProcess(root);
    this.signal.addEventListener('abort', () => { void this.process.stop(); }, { once: true });
  }
  start() {
    this.status.state = 'preparing';
    this.task = this.run().catch(error => {
      if (!this.signal.aborted) this.fail(error instanceof QQError ? error.message : '托管组件启动未完成，请检查完整安装包和系统运行环境。');
    });
  }
  private fail(error: string) {
    if (this.status.state === 'failed' || this.signal.aborted) return;
    this.status.state = 'failed'; this.status.error = error; delete this.status.qrCode;
    void Promise.resolve(this.onFailure()).catch(() => {}); this.controller.abort(); void this.process.stop();
  }
  private async post(path: string, body = {}, authenticate = true, timeout = 2500): Promise<Record<string, unknown>> {
    this.signal.throwIfAborted();
    if (authenticate && (!this.credential || Date.now() - this.credentialAt > 30 * 60_000)) {
      const login = await this.post('/api/auth/login', { hash: createHash('sha256').update(this.token + '.napcat').digest('hex') }, false);
      if (typeof login.Credential !== 'string') throw new QQError('engine_auth', '托管组件认证失败。');
      this.credential = login.Credential; this.credentialAt = Date.now();
    }
    const res = await fetch(this.base + path, { method: 'POST', redirect: 'error',
      headers: { 'Content-Type': 'application/json', ...(authenticate ? { Authorization: `Bearer ${this.credential}` } : {}) },
      body: JSON.stringify(body), signal: AbortSignal.any([this.signal, AbortSignal.timeout(timeout)]) });
    if (!res.ok) throw new QQError('engine_http', '托管组件暂未就绪。');
    const value = object(await res.json());
    if (value.code !== 0) { this.credential = ''; throw new QQError('engine_api', '托管组件暂未就绪或登录已失效。'); }
    return object(value.data);
  }
  async refreshQR() {
    const result = await this.post('/api/QQLogin/RefreshQRcode', {}, true, 15000);
    if (typeof result.qrcodeurl === 'string' && this.status.state === 'waiting_login') await this.updateQR(result.qrcodeurl);
  }
  private async updateQR(value: unknown) {
    const url = typeof value === 'string' && value.length < 4096 ? value : '';
    if (!url) { this.qrURL = ''; delete this.status.qrCode; return; }
    if (url === this.qrURL && this.status.qrCode) return;
    const png = await QRCode.toDataURL(url, { width: 240, margin: 2 });
    this.signal.throwIfAborted(); this.qrURL = url; this.status.qrCode = png;
  }
  private async run() {
    if (process.platform !== 'win32' || process.arch !== 'x64') throw new QQError('platform', '当前托管组件支持 Windows x64；其他系统可使用外部连接模式。');
    await verifyEngine(this.root, this.signal);
    let forceQR = false;
    while (!this.signal.aborted) {
      if (!await this.runSession(forceQR)) return;
      this.signal.throwIfAborted();
      // A rejected scan ends only that native login session. Keep the plugin,
      // configured identity, and the accepted account pin alive for another scan.
      this.process = new OwnedProcess(this.root);
      forceQR = true;
    }
  }
  private async runSession(forceQR: boolean): Promise<boolean> {
    this.credential = ''; this.credentialAt = 0; this.qrURL = '';
    const profile = join(this.root, 'data/managed-napcat');
    const configDir = join(profile, 'runtime/config');
    await mkdir(configDir, { recursive: true });
    this.signal.throwIfAborted();
    const wsPort = await freePort(this.signal);
    let webPort = await freePort(this.signal);
    while (webPort === wsPort) webPort = await freePort(this.signal);
    this.token = randomBytes(32).toString('hex');
    const wsToken = randomBytes(32).toString('hex');
    this.base = `http://127.0.0.1:${webPort}`;
    const onebot = { network: { httpServers: [], httpSseServers: [], httpClients: [], websocketClients: [], plugins: [],
      websocketServers: [{ name: 'whalelife-owned', enable: true, host: '127.0.0.1', port: wsPort, token: wsToken,
        messagePostFormat: 'array', reportSelfMessage: false, enableForcePushEvent: true, debug: false, heartInterval: 30000 }] } };
    await writeFile(join(configDir, 'onebot11.json'), JSON.stringify(onebot));
    // NapCat prioritizes per-account files. Refresh ONLY our own directory's files.
    const { readdir } = await import('node:fs/promises');
    for (const name of await readdir(configDir)) if (/^onebot11_\d+\.json$/.test(name)) await writeFile(join(configDir, name), JSON.stringify(onebot));
    let previousAccount = '';
    try { previousAccount = account(object(JSON.parse(await readFile(join(profile, 'identity.json'), 'utf8'))).accountId); } catch {}
    await writeFile(join(configDir, 'webui.json'), JSON.stringify({ host: '127.0.0.1', port: webPort, token: this.token, loginRate: 60,
      // A configured QQ number is an identity constraint, not saved login consent.
      autoLoginAccount: !forceQR && previousAccount && (!this.config.accountId || this.config.accountId === previousAccount) ? previousAccount : '',
      enable2FA: false, accessControlMode: 'whitelist', ipWhitelist: ['127.0.0.1', '::1'] }));
    await writeFile(join(configDir, 'napcat.json'), JSON.stringify({ fileLog: false, consoleLog: false, autoTimeSync: false }));
    this.signal.throwIfAborted();
    const engineRoot = join(this.root, 'vendor/napcat');
    this.status.state = 'starting';
    this.process.start(join(engineRoot, 'node.exe'), [join(this.root, 'managed/bootstrap.cjs')], engineRoot,
      { WHALE_QQ_ENGINE_ROOT: engineRoot, WHALE_QQ_PROFILE: profile, NAPCAT_WORKDIR: join(profile, 'runtime'),
        USERPROFILE: join(profile, 'home'), APPDATA: join(profile, 'home/AppData/Roaming'), LOCALAPPDATA: join(profile, 'home/AppData/Local') },
      () => this.fail('托管协议进程已退出；连接已停止，可关闭开关再开启。'));
    const deadline = Date.now() + 45000;
    let failures = 0, requestedMissingQR = false;
    while (!this.signal.aborted) {
      try {
        const state = await this.post('/api/QQLogin/CheckLoginStatus'); failures = 0;
        // No personal QQ profile was loaded: bootstrap must confirm isolation.
        if (!object(JSON.parse(await readFile(join(profile, 'storage-isolated.json'), 'utf8'))).version) throw new QQError('engine_storage', '托管组件未确认数据隔离。');
        if (state.isLogin === true) {
          const info = await this.post('/api/QQLogin/GetQQLoginInfo');
          const id = account(info.uin ?? info.user_id);
          if ((this.config.accountId && this.config.accountId !== id) || (this.status.accountId && this.status.accountId !== id)) {
            const expected = this.config.accountId || this.status.accountId;
            this.ready = false; this.status.state = 'starting'; this.status.error = '';
            this.status.loginNotice = `刚才扫码的账号不一致，未接入聊天。请用 QQ ${expected} 重新扫码；如果配置填错，可修改下方“机器人 QQ 号”并保存。`;
            delete this.status.qrCode;
            await this.onFailure();
            await this.process.stop();
            return true;
          }
          this.status.state = 'online'; this.status.accountId = id; this.status.error = ''; this.qrURL = ''; delete this.status.qrCode; delete this.status.loginNotice;
          if (!this.ready) {
            await writeFile(join(profile, 'identity.json'), JSON.stringify({ accountId: id }));
            this.signal.throwIfAborted();
            try { this.onReady({ ...this.config, accountId: id, wsUrl: `ws://127.0.0.1:${wsPort}/`, accessToken: wsToken }); }
            catch { throw new QQError('engine_session', 'QQ 已登录，但会话初始化失败，请检查所选人格和模型配置。'); }
            this.ready = true;
          }
        } else {
          if (this.ready) { this.ready = false; await this.onFailure(); }
          this.status.state = 'waiting_login';
          const loginError = typeof state.loginError === 'string' ? state.loginError.trim() : '';
          this.status.error = !loginError ? '' : /重复登录|已登录/.test(loginError)
            ? 'QQ 提示该账号已登录，暂时无法重复登录。请检查同账号的其他 QQ 客户端或机器人，再刷新二维码。'
            : 'QQ 登录未完成。请刷新二维码；若手机 QQ 提示验证，请在手机上完成。';
          await this.updateQR(state.qrcodeurl);
          // Upstream can wait for a saved quick-login choice without producing a
          // QR. Request one once; keep the visible refresh button for retries.
          if (!this.status.qrCode && !requestedMissingQR && state.loginPhase === 'waiting_qrcode') {
            requestedMissingQR = true;
            await this.refreshQR();
          }
        }
      } catch (error) {
        if (error instanceof QQError && ['engine_storage','engine_session'].includes(error.code)) throw error;
        if ((this.status.state === 'starting' && Date.now() > deadline) || (this.status.state !== 'starting' && ++failures > 6))
          throw new QQError('engine_timeout', '托管组件未能正常响应，已停止；请检查组件或重新开启。');
      }
      await delay(1500, undefined, { signal: this.signal });
    }
    return false;
  }
  async stop() {
    this.controller.abort(); delete this.status.qrCode;
    await Promise.all([this.process.stop(), this.task?.catch(() => {})]);
    if (this.status.state !== 'failed') this.status.state = 'stopped';
  }
}
