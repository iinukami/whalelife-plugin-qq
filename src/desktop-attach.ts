/*! Copyright (c) 2026 iinukami and contributors.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */
import { randomBytes, createHash } from 'node:crypto';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:http';
import { readFile, writeFile, mkdir, rename, mkdtemp, rm, realpath, lstat } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { once } from 'node:events';
import { QQError, type Config } from './config.ts';
import { DesktopBridge, verifyDesktopEngine } from './desktop-bridge.ts';
import { pluginRoot } from './managed-engine.ts';

export interface DesktopProcess { pid: number; startedAt: string; path: string; }
export interface DesktopIdentity { accountId: string; uid: string; nickname: string; online: boolean; bridge: 'none' | 'legacy' | 'attached'; }
interface Selection { version: 1; process: DesktopProcess; accountId: string; wsUrl: string; accessToken: string; }
interface Candidate extends DesktopProcess, DesktopIdentity { id: string; }
const run = promisify(execFile);
export const processKey = (p: DesktopProcess) => createHash('sha256').update(JSON.stringify([p.pid, p.startedAt, p.path.toLowerCase()])).digest('hex');
export async function desktopProcesses(signal: AbortSignal): Promise<DesktopProcess[]> {
  if (process.platform !== 'win32' || process.arch !== 'x64') throw new QQError('attach_platform', '选择已登录 QQ 目前支持 Windows x64。');
  const result = await run(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe'), ['-NoProfile', '-NonInteractive', '-Command',
    "@((Get-CimInstance Win32_Process -Filter \"Name='QQ.exe'\" | Where-Object { $_.ExecutablePath -and $_.CommandLine -notmatch '--type=' }) | ForEach-Object { @{pid=$_.ProcessId;startedAt=$_.CreationDate.ToUniversalTime().ToString('o');path=$_.ExecutablePath} }) | ConvertTo-Json -Compress"],
  { windowsHide: true, signal, timeout: 10000 });
  const parsed = result.stdout.trim() ? JSON.parse(result.stdout) : [];
  return (Array.isArray(parsed) ? parsed : [parsed]).filter((p: any) => Number.isSafeInteger(p.pid) && p.pid > 0 && typeof p.startedAt === 'string' && typeof p.path === 'string').slice(0, 8);
}

export async function remoteDesktop(root: string, processInfo: DesktopProcess, input: Record<string, unknown>, signal: AbortSignal): Promise<DesktopIdentity> {
  signal.throwIfAborted();
  const nonce = randomBytes(32).toString('hex');
  let child: ReturnType<typeof spawn> | undefined;
  let childClosed: Promise<void> | undefined, temporary: string | undefined;
  const temporaryRoot = resolve(root, 'data/desktop-attach/tmp');
  const controller = new AbortController(), combined = AbortSignal.any([signal, controller.signal]);
  let settle!: (v: DesktopIdentity) => void, reject!: (e: unknown) => void;
  const result = new Promise<DesktopIdentity>((ok, fail) => { settle = ok; reject = fail; });
  // Catch immediately: child failure may arrive before the server has started.
  void result.catch(() => {});
  const server = createServer((req, res) => {
    void (async () => {
      if (req.method !== 'POST' || req.url !== '/' + nonce) { res.writeHead(404).end(); return; }
      let body = ''; for await (const chunk of req) { body += chunk; if (Buffer.byteLength(body) > 8192) throw Error('large'); }
      const value = JSON.parse(body); res.writeHead(200).end();
      if (!value.ok) throw new QQError('attach_probe', '读取或接入桌面 QQ 未完成；当前 QQ 登录保持不变。');
      const identity = value.value;
      if (!/^\d{5,20}$/.test(identity?.accountId) || typeof identity.uid !== 'string' || !identity.online || !['none','legacy','attached'].includes(identity.bridge)) throw Error('invalid identity');
      settle(identity);
    })().catch(e => { if (!res.writableEnded) res.writeHead(400).end(); reject(e); });
  });
  const abort = () => reject(new QQError('attach_cancelled', '接入已取消。'));
  combined.addEventListener('abort', abort, { once: true });
  const timeout = setTimeout(() => reject(new QQError('attach_timeout', 'QQ 未及时响应接入请求，请刷新重试；不会重启或退出 QQ。')), 45000);
  try {
    await mkdir(temporaryRoot, { recursive: true });
    if (resolve(await realpath(temporaryRoot)) !== temporaryRoot || (await lstat(temporaryRoot)).isSymbolicLink()) throw new QQError('attach_temp', '接入临时目录必须位于插件自己的数据目录。');
    temporary = await mkdtemp(join(temporaryRoot, 'probe-'));
    server.listen(0, '127.0.0.1'); await once(server, 'listening'); combined.throwIfAborted();
    const port = (server.address() as { port: number }).port;
    const args = { ...input, deadline: Date.now() + 40000, legacyWorkdir: join(root, 'data/desktop-bridge/runtime') };
    // Work is scheduled after the native callback returns, avoiding reentrant dlopen.
    const agentFile = JSON.stringify(join(root, 'attach/agent.cjs'));
    const expression = `setImmediate(async()=>{let value;try{const req=process.mainModule.require.bind(process.mainModule);delete req('node:module')._cache[${agentFile}];value={ok:true,value:await req(${agentFile}).run(${JSON.stringify(args)})}}catch{value={ok:false}}try{const r=process.mainModule.require('node:http').request({hostname:'127.0.0.1',port:${port},path:${JSON.stringify('/' + nonce)},method:'POST',timeout:3000},r=>r.resume());r.on('error',()=>{});r.on('timeout',()=>r.destroy());r.end(JSON.stringify(value))}catch{}});`;
    child = spawn(process.execPath, [join(root, 'attach/worker.mjs')], { windowsHide: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      env: { ...process.env, TEMP: temporary, TMP: temporary, TMPDIR: temporary } });
    childClosed = new Promise<void>(ok => child!.once('close', () => ok()));
    child.on('error', () => reject(new QQError('attach_worker', '桌面接入组件未能启动，请检查插件安装。')));
    child.on('message', (message: any) => { if (!message.ok) reject(new QQError('attach_worker', '当前 QQ 版本暂未通过接入探测，桌面登录保持不变。')); });
    child.once('exit', code => { if (code !== 0) reject(new QQError('attach_worker', '接入组件异常退出，未停止桌面 QQ。')); });
    child.send!({ pid: processInfo.pid, expression });
    return await result;
  } finally {
    clearTimeout(timeout); combined.removeEventListener('abort', abort); controller.abort();
    if (child?.pid && child.exitCode === null && child.signalCode === null) {
      // Allow Frida to detach and finish normal cleanup before terminating a slow
      // helper. Cancellation still respects the host's short stop deadline.
      if (!signal.aborted) {
        let grace: ReturnType<typeof setTimeout> | undefined;
        try { await Promise.race([childClosed, new Promise<void>(ok => { grace = setTimeout(ok, 1500); })]); }
        finally { clearTimeout(grace); }
      }
      // Only our helper is owned. The selected QQ process is never terminated.
      if (child.exitCode === null && child.signalCode === null) { child.kill(); await childClosed; }
    }
    server.closeAllConnections(); await new Promise<void>(ok => server.close(() => ok()));
    if (temporary) {
      if (dirname(resolve(temporary)) !== temporaryRoot || resolve(await realpath(temporaryRoot)) !== temporaryRoot || (await lstat(temporary)).isSymbolicLink())
        throw new QQError('attach_temp', '接入临时目录发生变化，已停止清理。');
      await rm(temporary, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    }
  }
}

export class DesktopAttach {
  private candidates = new Map<string, Candidate>();
  readonly root: string;
  readonly processes: typeof desktopProcesses;
  readonly remote: typeof remoteDesktop;
  constructor(root = pluginRoot, processes = desktopProcesses, remote = remoteDesktop) {
    this.root = root; this.processes = processes; this.remote = remote;
  }
  async list(signal: AbortSignal) {
    const entries: { id: string; pid: number; accountId?: string; nickname?: string; available: boolean; error?: string }[] = [];
    this.candidates.clear();
    for (const p of await this.processes(signal)) {
      signal.throwIfAborted(); const id = processKey(p);
      try {
        const self = await this.remote(this.root, p, { operation: 'inspect' }, signal);
        this.candidates.set(id, { ...p, ...self, id });
        entries.push({ id, pid: p.pid, accountId: self.accountId, nickname: self.nickname, available: true });
      } catch (e) { signal.throwIfAborted(); entries.push({ id, pid: p.pid, available: false, error: e instanceof QQError ? e.message : '尚未登录或当前版本无法接入。' }); }
    }
    return entries;
  }
  async connect(id: string, config: Config, signal: AbortSignal): Promise<Config> {
    const candidate = this.candidates.get(id);
    if (!candidate) throw new QQError('attach_stale', '账号列表已过期，请刷新后重新选择。');
    const live = await this.processes(signal);
    const current = live.find(p => processKey(p) === id);
    if (!current) throw new QQError('attach_stale', '所选 QQ 已退出或重新启动，请刷新账号列表。');
    const self = await this.remote(this.root, current, { operation: 'inspect' }, signal);
    if (self.accountId !== candidate.accountId || self.uid !== candidate.uid) throw new QQError('attach_changed', '所选 QQ 的登录账号已改变，请刷新后重新选择。');
    let effective: Config;
    if (self.bridge === 'legacy') effective = await new DesktopBridge({ ...config, accountId: self.accountId }, signal, this.root).prepare();
    else {
      const base = join(this.root, 'data/desktop-attach', id);
      effective = await new DesktopBridge({ ...config, accountId: self.accountId }, signal, base).prepare();
      await verifyDesktopEngine(this.root, signal);
      await this.remote(this.root, current, { operation: 'connect', accountId: self.accountId, uid: self.uid,
        framework: join(this.root, 'vendor/napcat-framework'), workdir: join(base, 'data/desktop-bridge/runtime'),
        previousWorkdir: await this.previousWorkdir(current, live, self.accountId, signal) }, signal);
    }
    signal.throwIfAborted();
    const selection: Selection = { version: 1, process: current, accountId: self.accountId, wsUrl: effective.wsUrl, accessToken: effective.accessToken };
    const dir = join(this.root, 'data/desktop-attach'); await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'selected.json.tmp'), JSON.stringify(selection), { mode: 0o600 });
    signal.throwIfAborted(); await rename(join(dir, 'selected.json.tmp'), join(dir, 'selected.json'));
    return { ...effective, connectionMode: 'attach', accountId: self.accountId };
  }
  private async previousWorkdir(current: DesktopProcess, live: DesktopProcess[], accountId: string, signal: AbortSignal) {
    let saved: Selection;
    try { saved = JSON.parse(await readFile(join(this.root, 'data/desktop-attach/selected.json'), 'utf8')); }
    catch { return; } // Missing or untrusted records cannot authorize stale-environment recovery.
    signal.throwIfAborted();
    if (saved?.version !== 1 || saved.accountId !== accountId || !saved.process ||
        !Number.isSafeInteger(saved.process.pid) || saved.process.pid <= 0 ||
        typeof saved.process.startedAt !== 'string' || !Number.isFinite(Date.parse(saved.process.startedAt)) ||
        typeof saved.process.path !== 'string' || !saved.process.path ||
        resolve(saved.process.path).toLowerCase() !== resolve(current.path).toLowerCase() ||
        !/^ws:\/\/127\.0\.0\.1:\d+\/$/.test(saved.wsUrl) || !/^[a-f0-9]{64}$/.test(saved.accessToken)) return;
    const previous = processKey(saved.process);
    if (previous === processKey(current) || live.some(p => processKey(p) === previous)) return;
    return join(this.root, 'data/desktop-attach', previous, 'data/desktop-bridge/runtime');
  }
  async resume(config: Config, signal: AbortSignal): Promise<Config | undefined> {
    let saved: Selection;
    try { saved = JSON.parse(await readFile(join(this.root, 'data/desktop-attach/selected.json'), 'utf8')); }
    catch (e: any) { if (e.code === 'ENOENT') return; throw new QQError('attach_config', '桌面接入记录损坏，原文件已保留。'); }
    if (saved.version !== 1 || saved.accountId !== config.accountId || !/^ws:\/\/127\.0\.0\.1:\d+\/$/.test(saved.wsUrl) || !/^[a-f0-9]{64}$/.test(saved.accessToken) || !saved.process?.path)
      throw new QQError('attach_config', '桌面接入记录与当前配置不一致，请重新选择账号。');
    if (!(await this.processes(signal)).some(p => processKey(p) === processKey(saved.process))) return;
    return { ...config, wsUrl: saved.wsUrl, accessToken: saved.accessToken };
  }
}
