import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdir, writeFile, cp, readFile, access } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { TestContext } from 'node:test';
import { WebSocketServer, WebSocket } from 'ws';
import { boot } from '../../whalelife/core/index.ts';
import { temporaryDirectory } from '../../whalelife/tests/temporary-directory.ts';
import { defaults, type Config } from '../src/config.ts';

export async function until(check: () => unknown | Promise<unknown>, timeout = 7000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await check()) return; await new Promise(r => setTimeout(r, 15)); }
  throw Error('Condition not reached before deadline');
}
export async function fixture(t: TestContext, options: { config?: Partial<Config>; rawConfig?: Record<string, unknown>; proxy?: string; modelTimeout?: number; packagePath?: string; includeQzone?: boolean; includeVendor?: boolean; unconfigured?: boolean; preparePlugin?: (root: string) => Promise<void>; prepareHost?: (root: string) => Promise<void>; hostBoot?: typeof boot; temporaryDirectory?: typeof temporaryDirectory } = {}) {
  const root = await (options.temporaryDirectory ?? temporaryDirectory)('whale-qq-plugin-');
  let app: Awaited<ReturnType<typeof boot>> | undefined;
  let ws: WebSocket | undefined;
  const calls: any[] = [], generations: any[] = [], modelCalls: any[] = [];
  let connects = 0, sentId = 9000;
  let action: ((data: any, socket: WebSocket) => Promise<boolean> | boolean) | undefined;
  let modelHandler: ((req: IncomingMessage, res: ServerResponse) => Promise<void> | void) | undefined;
  let generate: ((input: any) => Promise<any>) | undefined;
  const modelServer = createServer((req, res) => {
    void (async () => {
      if (modelHandler) return modelHandler(req, res);
      const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(chunk);
      const body = Buffer.concat(chunks).toString(); modelCalls.push({ path: req.url, body, authorization: req.headers.authorization });
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(req.url?.endsWith('/audio/transcriptions') ? { text: '模型转写：明天见' } : { choices: [{ message: { content: '一只开心的小猫，正在挥手。' } }] }));
    })().catch(() => { if (!res.destroyed) res.destroy(); });
  });
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  t.after(async () => {
    await app?.close();
    for (const socket of server.clients) socket.terminate();
    await new Promise<void>(r => server.close(() => r()));
    modelServer.closeAllConnections();
    await new Promise<void>(r => modelServer.close(() => r()));
  });
  await once(server, 'listening');
  modelServer.listen(0, '127.0.0.1'); await once(modelServer, 'listening');
  const wsUrl = `ws://127.0.0.1:${(server.address() as { port: number }).port}/`;
  const modelUrl = `http://127.0.0.1:${(modelServer.address() as { port: number }).port}`;
  server.on('connection', (socket, req) => {
    connects++; ws = socket;
    socket.on('error', () => {});
    socket.on('message', bytes => {
      void (async () => {
        const data = JSON.parse(bytes.toString()); calls.push({ ...data, authorization: req.headers.authorization });
        if (action && await action(data, socket)) return;
        const response = data.action === 'get_login_info' ? { user_id: 100001, nickname: 'test' }
          : data.action === 'send_private_msg' ? { message_id: sentId++ }
          : data.action === 'fetch_ptt_text' ? { text: '明天下午三点见🙂' }
          : data.action === 'fetch_face_entity' ? { q_des: '比心' } : {};
        socket.send(JSON.stringify({ status: 'ok', retcode: 0, data: response, echo: data.echo }));
      })().catch(() => {});
    });
  });
  await mkdir(join(root, 'config'), { recursive: true });
  await cp(options.packagePath ?? fileURLToPath(new URL('../dist/qq', import.meta.url)), join(root, 'plugins/qq'), { recursive: true, filter: source => options.includeVendor === true || (!source.replaceAll('\\', '/').includes('/vendor/') && !source.replaceAll('\\', '/').endsWith('/vendor')) });
  const spaceBuild = fileURLToPath(new URL('../../whalelife-plugin-qzone/dist/qzone', import.meta.url));
  if (options.includeQzone !== false && await access(spaceBuild).then(() => true, () => false)) await cp(spaceBuild, join(root, 'plugins/qq/sub/qzone'), { recursive: true });
  await mkdir(join(root, 'plugins/qq/data'));
  const config = { ...defaults, connectionMode: 'external', enabled: true, wsUrl, accessToken: 'fake-onebot-secret', accountId: '100001',
    allowedUsers: ['200002'], visionModelId: 'vision', sttModelId: 'stt',
    minReplyIntervalMs: 0, requestTimeoutMs: 1000, reconnectMaxMs: 1000, mediaHosts: ['127.0.0.1'], ...options.config };
  if (!options.unconfigured) await writeFile(join(root, 'plugins/qq/data/config.json'), JSON.stringify(options.rawConfig ?? config));
  await options.preparePlugin?.(join(root, 'plugins/qq'));
  await mkdir(join(root, 'plugins/witness'), { recursive: true });
  await writeFile(join(root, 'plugins/witness/plugin.yaml'), 'id: witness\nname: witness\nversion: 1.0.0\ndescription: test-only isolation witness\napiVersion: "1.0.0"\n');
  await writeFile(join(root, 'plugins/witness/index.ts'), "export function apply(ctx) { ctx.provide('witness', { ping: () => 'alive' }); }");
  await writeFile(join(root, 'config/config.json'), JSON.stringify({
    log: { level: 'error' }, web: { port: 0 },
    providers: [{ id: 'test', name: 'test', base_url: modelUrl + '/v1', api_key: 'fake-model-secret', timeout_seconds: options.modelTimeout ?? 10, proxy_url: options.proxy ?? '' }],
    models: ['chat', 'vision', 'stt'].map(name => ({ id: name, name, provider: 'test', model: name, type: name === 'stt' ? 'stt' : 'chat', enabled: true, ...(name === 'stt' ? {} : { context_window: 32000 }) })),
    model_bindings: { chat: 'chat' },
    personas: { a: { name: 'A', file: 'a.md', model: 'chat', permission: 'off' }, b: { name: 'B', file: 'b.md', model: 'chat', permission: 'off' } },
    channels: { web: { persona: 'a', permission: 'off' } }, memory: { root: 'memory', budget_tokens: 6000 },
  }));
  await options.prepareHost?.(root);
  app = await (options.hostBoot ?? boot)(root);
  app.llm.chat = async (input: any) => { generations.push(input); return generate ? generate(input) : { text: '测试回复🙂', toolCalls: [], usage: { prompt_tokens: 10, completion_tokens: 5 } }; };
  const url = `http://127.0.0.1:${app.web.server.address().port}`;
  const login = await fetch(url + '/api/login', { method: 'POST', body: '{}' });
  const cookie = login.headers.get('set-cookie')!.split(';')[0];
  const request = (path: string, body?: unknown) => fetch(url + path, { method: body === undefined ? 'GET' : 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const status = async () => (await request('/plugins/qq/status')).json();
  const online = async () => {
    try { await until(async () => (await status()).state === 'online'); }
    catch { throw Error(JSON.stringify({ status: await status(), runtime: app!.runtime.records.get('qq')?.status, error: app!.runtime.records.get('qq')?.error, connects, calls: calls.map(x => x.action) })); }
  };
  const send = (patch: any = {}) => ws!.send(JSON.stringify({ post_type: 'message', message_type: 'private', sub_type: 'friend', self_id: 100001, user_id: 200002,
    message_id: 1, message: [{ type: 'text', data: { text: '你好🙂' } }], ...patch }));
  const save = async (patch: any) => {
    const current = await (await request('/plugins/qq/config')).json();
    return request('/plugins/qq/config', { revision: current.revision, config: { ...current.config, ...patch } });
  };
  return { root, app, url, modelUrl, request, status, online, send, save, calls, generations, modelCalls,
    connects: () => connects, socket: () => ws!,
    setAction(fn: typeof action) { action = fn; }, setModelHandler(fn: typeof modelHandler) { modelHandler = fn; }, setGenerate(fn: typeof generate) { generate = fn; },
    async configFile() { return JSON.parse(await readFile(join(root, 'plugins/qq/data/config.json'), 'utf8')); },
  };
}

export async function selectOnWeb(f: Awaited<ReturnType<typeof fixture>>, id: 'a' | 'b') {
  const current = await (await f.request('/api/model-config')).json();
  const saved = await f.request('/api/model-config', {
    revision: current.revision, timezone: current.timezone, activePersona: id,
    models: current.models, providers: current.providers, bindings: current.bindings,
    personaModels: Object.fromEntries(current.personas.map((p: { id: string; model?: string }) => [p.id, p.model || null])),
  });
  const updated = await saved.json();
  assert.equal(saved.status, 200, JSON.stringify(updated));
  assert.equal(updated.activePersona, id);
}
