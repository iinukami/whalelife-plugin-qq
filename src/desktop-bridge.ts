import { randomBytes, createHash } from 'node:crypto';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:net';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, writeFile, rename, readdir, stat } from 'node:fs/promises';
import { join, resolve, sep, basename } from 'node:path';
import { pluginRoot } from './managed-engine.ts';
import { QQError, object, type Config } from './config.ts';

interface Connection { version: 1; wsPort: number; webPort: number; accessToken: string; webToken: string; }
const run = promisify(execFile);
const powershell = () => join(process.env.SystemRoot ?? 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
const validPort = (x: unknown): x is number => Number.isInteger(x) && Number(x) > 1024 && Number(x) < 65536;
const validToken = (x: unknown): x is string => typeof x === 'string' && /^[a-f0-9]{64}$/.test(x);
async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((ok, fail) => { server.once('error', fail); server.listen(0, '127.0.0.1', ok); });
  const port = (server.address() as { port: number }).port;
  await new Promise<void>(ok => server.close(() => ok())); return port;
}

export async function verifyDesktopEngine(root: string, signal: AbortSignal) {
  const manifest = object(JSON.parse(await readFile(join(root, 'vendor/desktop-manifest.json'), 'utf8')));
  if (manifest.version !== '4.18.41') throw new QQError('desktop_package', '桌面接入组件版本不匹配，请修复插件安装。');
  const files = object(manifest.files), base = resolve(root, 'vendor/napcat-framework');
  for (const name of ['napimain.exe', 'napiloader.dll', 'nativeLoader.cjs', 'napcat.mjs'])
    if (!files[name]) throw new QQError('desktop_package', '桌面接入组件不完整，请修复插件安装。');
  for (const [name, expected] of Object.entries(files)) {
    signal.throwIfAborted(); const file = resolve(base, name);
    if (!file.startsWith(base + sep) || typeof expected !== 'string') throw new QQError('desktop_package', '桌面组件校验清单无效。');
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(file, { signal })) hash.update(chunk);
    if (hash.digest('hex') !== expected) throw new QQError('desktop_package', '桌面接入组件校验失败，已取消启动。');
  }
}

export async function desktopQQPath(configured: string, signal: AbortSignal) {
  let exe = configured;
  if (!exe) {
    const result = await run(powershell(), ['-NoProfile', '-NonInteractive', '-Command',
      "$q=(Get-ItemProperty -LiteralPath 'HKLM:\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\QQ' -ErrorAction Stop).UninstallString; Join-Path ([IO.Path]::GetDirectoryName($q.Trim('\"'))) 'QQ.exe'"],
    { windowsHide: true, signal, timeout: 10000 });
    exe = result.stdout.trim();
  }
  if (!exe || basename(exe).toLowerCase() !== 'qq.exe' || !(await stat(exe)).isFile())
    throw new QQError('desktop_path', '未找到桌面 QQ，请在设置中填写 QQ.exe 的完整路径。');
  return resolve(exe);
}

export async function desktopQQRunning(exe: string, signal: AbortSignal) {
  const result = await run(powershell(), ['-NoProfile', '-NonInteractive', '-Command',
    "$q=@(Get-CimInstance Win32_Process -Filter \"Name='QQ.exe'\" | Where-Object { $_.ExecutablePath -eq $env:WHALE_DESKTOP_QQ_EXE -and $_.CommandLine -notmatch '--type=' }); $q.Count"],
  { windowsHide: true, signal, timeout: 10000, env: { ...process.env, WHALE_DESKTOP_QQ_EXE: exe } });
  return Number(result.stdout.trim()) > 0;
}

// This connection belongs to the desktop client. Plugin stop must only close its
// OneBot connection; it must never terminate, log out or own the desktop process.
export class DesktopBridge {
  readonly root: string;
  readonly signal: AbortSignal;
  private config: Config;
  constructor(config: Config, signal: AbortSignal, root = pluginRoot) {
    this.config = config; this.signal = signal; this.root = root;
  }
  async prepare(): Promise<Config> {
    this.signal.throwIfAborted();
    const base = join(this.root, 'data/desktop-bridge'), file = join(base, 'connection.json');
    await mkdir(base, { recursive: true });
    let saved: Connection;
    try {
      saved = JSON.parse(await readFile(file, 'utf8'));
      if (saved.version !== 1 || !validPort(saved.wsPort) || !validPort(saved.webPort) || saved.wsPort === saved.webPort || !validToken(saved.accessToken) || !validToken(saved.webToken))
        throw new QQError('desktop_config', '桌面接入记录无效，原文件已保留，请修复配置。');
    } catch (error: any) {
      if (error.code !== 'ENOENT') throw error;
      const wsPort = await freePort(); let webPort = await freePort();
      while (webPort === wsPort) webPort = await freePort();
      saved = { version: 1, wsPort, webPort, accessToken: randomBytes(32).toString('hex'), webToken: randomBytes(32).toString('hex') };
      this.signal.throwIfAborted();
      await writeFile(file + '.tmp', JSON.stringify(saved), { mode: 0o600 }); await rename(file + '.tmp', file);
    }
    const dir = join(base, 'runtime/config'); await mkdir(dir, { recursive: true });
    const onebot = { network: { httpServers: [], httpSseServers: [], httpClients: [], websocketClients: [], plugins: [],
      websocketServers: [{ name: 'whalelife-desktop', enable: true, host: '127.0.0.1', port: saved.wsPort, token: saved.accessToken,
        messagePostFormat: 'array', reportSelfMessage: false, enableForcePushEvent: true, debug: false, heartInterval: 30000 }] } };
    this.signal.throwIfAborted();
    for (const name of ['onebot11.json', ...(await readdir(dir)).filter(n => /^onebot11_\d+\.json$/.test(n))])
      await writeFile(join(dir, name), JSON.stringify(onebot));
    await writeFile(join(dir, 'webui.json'), JSON.stringify({ host: '127.0.0.1', port: saved.webPort, token: saved.webToken,
      autoLoginAccount: '', enable2FA: false, accessControlMode: 'whitelist', ipWhitelist: ['127.0.0.1', '::1'] }));
    await writeFile(join(dir, 'napcat.json'), JSON.stringify({ fileLog: false, consoleLog: false, autoTimeSync: false }));
    this.signal.throwIfAborted();
    return { ...this.config, wsUrl: `ws://127.0.0.1:${saved.wsPort}/`, accessToken: saved.accessToken };
  }
  async open(requestSignal = this.signal) {
    const signal = AbortSignal.any([this.signal, requestSignal]);
    if (process.platform !== 'win32' || process.arch !== 'x64') throw new QQError('desktop_platform', '内置桌面接入目前支持 Windows x64；其他系统可连接已有协议端。');
    signal.throwIfAborted();
    const exe = await desktopQQPath(this.config.qqPath, signal);
    if (await desktopQQRunning(exe, signal)) throw new QQError('desktop_running', '桌面 QQ 已打开。首次接入请正常退出 QQ 后，再点“打开桌面 QQ”；登录资料会保留。已接入的 QQ 不需要重新打开。');
    await verifyDesktopEngine(this.root, signal); await this.prepare();
    signal.throwIfAborted();
    const framework = join(this.root, 'vendor/napcat-framework'), loader = join(framework, 'nativeLoader.cjs').replaceAll('\\', '/');
    const child = spawn(join(framework, 'napimain.exe'), [exe, join(framework, 'napiloader.dll'), loader], {
      cwd: framework, detached: true, windowsHide: true, stdio: 'ignore',
      env: { ...process.env, NAPCAT_WORKDIR: join(this.root, 'data/desktop-bridge/runtime'), NAPCAT_MAIN_PATH: loader },
    });
    await new Promise<void>((ok, fail) => { child.once('error', fail); child.once('spawn', ok); }); child.unref();
    // Intentionally no PID-based teardown, stdin lease, Job membership, or logout.
    return { opened: true };
  }
}
