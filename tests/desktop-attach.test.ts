import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { temporaryDirectory } from '../../whalelife/tests/temporary-directory.ts';
import { defaults, parseConfig } from '../src/config.ts';
import { DesktopAttach, processKey, type DesktopProcess, type DesktopIdentity } from '../src/desktop-attach.ts';
import { DesktopBridge } from '../src/desktop-bridge.ts';
import { page, script } from '../src/page.ts';
const { createAgent } = createRequire(import.meta.url)('../attach/agent.cjs');
const controller = () => new AbortController();
const processInfo: DesktopProcess = { pid: 123, startedAt: '2026-11-01T00:00:00Z', path: 'C:\\QQ\\QQ.exe' };
const identity: DesktopIdentity = { accountId: '100001', uid: 'u_test', nickname: 'Test', online: true, bridge: 'legacy' };
const config = parseConfig({ ...defaults, connectionMode: 'attach', enabled: true, personaId: 'test', allowedUsers: ['200002'] });

test('selection reuses existing credentials, survives plugin restart, and exposes no tokens or UID', async () => {
  const root = await temporaryDirectory('whale-qq-attach-select-');
  const signal = controller().signal;
  const prior = await new DesktopBridge(config, signal, root).prepare();
  const attach = new DesktopAttach(root, async () => [processInfo], async () => identity);
  const listed = await attach.list(signal);
  assert.equal(listed.length, 1); assert.equal(listed[0].accountId, '100001');
  assert.ok(!JSON.stringify(listed).includes('u_test')); assert.ok(!JSON.stringify(listed).includes(prior.accessToken));
  const selected = await attach.connect(listed[0].id, config, signal);
  assert.equal(selected.accountId, '100001'); assert.equal(selected.wsUrl, prior.wsUrl); assert.equal(selected.accessToken, prior.accessToken);
  const resumed = await new DesktopAttach(root, async () => [processInfo], async () => { throw Error('must not inject on reload'); }).resume(selected, signal);
  assert.equal(resumed?.accessToken, prior.accessToken);
});

test('PID reuse and account switch are rejected before any connection record is written', async () => {
  const root = await temporaryDirectory('whale-qq-attach-races-');
  const signal = controller().signal;
  let live = processInfo, self = identity, calls = 0;
  const attach = new DesktopAttach(root, async () => [live], async () => { calls++; return self; });
  const [candidate] = await attach.list(signal);
  live = { ...processInfo, startedAt: 'later' };
  await assert.rejects(attach.connect(candidate.id, config, signal), /退出或重新启动/); assert.equal(calls, 1);
  live = processInfo; self = { ...identity, accountId: '100002' };
  await assert.rejects(attach.connect(candidate.id, config, signal), /账号已改变/);
  await assert.rejects(readFile(join(root, 'data/desktop-attach/selected.json')), { code: 'ENOENT' });
});

test('closed QQ stays disconnected on reload; corrupted selection is preserved', async () => {
  const root = await temporaryDirectory('whale-qq-attach-resume-'), signal = controller().signal;
  const attach = new DesktopAttach(root, async () => [processInfo], async () => identity);
  const [candidate] = await attach.list(signal); const selected = await attach.connect(candidate.id, config, signal);
  assert.equal(await new DesktopAttach(root, async () => []).resume(selected, signal), undefined);
  const file = join(root, 'data/desktop-attach/selected.json'); await writeFile(file, '{bad');
  await assert.rejects(attach.resume(selected, signal), /原文件已保留/); assert.equal(await readFile(file, 'utf8'), '{bad');
});

function nativeFixture(factory = createAgent) {
  let nextId = 0, nativeLogins = 0, initialize = 0;
  let current: any = { uid: 'u_test', status: 10 }, mappedAccount = '100001';
  const globals = {};
  const listeners = new Map<number, any>(); const events: string[] = [];
  let messageListener: any;
  const emit = (info: any) => { current = info; for (const listener of listeners.values()) listener.onSelfStatusChanged(info); };
  const profile = {
    addKernelProfileListener(listener: any) { const id = ++nextId; listeners.set(id, listener); return id; },
    removeKernelProfileListener(id: number) { listeners.delete(id); },
    getSelfStatus() { emit(current); return Promise.resolve({ result: 0 }); },
    getUinByUid() { return new Map([['u_test', mappedAccount]]); },
  };
  const login = { getLoginList: async () => ({ LocalLoginInfoList: [{ uin: '100001', nickName: 'Test' }] }),
    addKernelLoginListener() { nativeLogins++; throw Error('native login must not be registered'); },
    quickLoginWithUin() { nativeLogins++; }, getQRCodePicture() { nativeLogins++; } };
  const session = { getProfileService: () => profile, getMsgService: () => ({ sendMsg() { events.push('sent'); }, addKernelMsgListener(listener: any) { messageListener = listener; } }),
    init() { throw Error('must not reinitialize'); }, close() { throw Error('must not close QQ'); } };
  const runtime = { type: 'browser', env: {} as Record<string, string>, mainModule: { filename: 'C:\\QQ\\resources\\app\\application.asar\\main.js' },
    dlopen(module: any) { module.exports = { NodeIQQNTWrapperSession: { getNTWrapperSession: () => session }, NodeIKernelLoginService: { get: () => login } }; } };
  let guarded: any;
  const load = async () => ({ async NCoreInitFramework(s: any, facade: any, ready: any) {
    initialize++; guarded = s;
    await new Promise<void>(resolve => facade.addKernelLoginListener({ onQRCodeLoginSucceed(info: any) {
      assert.equal(info.uid, 'u_test'); assert.equal(info.uin, '100001'); ready(resolve);
    } }));
    assert.throws(() => facade.getQRCodePicture(), /desktop_login_owned_by_user/);
  } });
  const agent = factory(runtime, globals, load);
  const input = { deadline: Date.now() + 10000, legacyWorkdir: 'C:\\old', workdir: 'C:\\owned', framework: 'C:\\framework', accountId: '100001', uid: 'u_test' };
  return { agent, input, listeners, events, runtime, emit, globals,
    mapAccount: (account: string) => { mappedAccount = account; },
    emitMessage: () => messageListener?.onMessage(), upgrade: () => createAgent(runtime, globals, load),
    counts: () => ({ nativeLogins, initialize }), guarded: () => guarded };
}

test('offline pauses native calls and callbacks; verified same-account recovery restores both without new login', async () => {
  const f = nativeFixture(); await f.agent.run({ ...f.input, operation: 'connect' });
  let received = 0;
  const messages = f.guarded().getMsgService();
  messages.addKernelMsgListener({ onMessage() { received++; } });
  for (let i = 0; i < 3; i++) {
    f.emit({ uid: 'u_test', status: 20 });
    assert.throws(() => messages.sendMsg(), /selected_account_offline/);
    f.emitMessage(); assert.equal(received, i);
    f.emit({ uid: 'u_test', status: 10 });
    messages.sendMsg(); f.emitMessage(); assert.equal(received, i + 1);
    await f.agent.run({ ...f.input, operation: 'connect' });
  }
  assert.equal(f.events.length, 3); assert.equal(f.listeners.size, 1);
  assert.deepEqual(f.counts(), { nativeLogins: 0, initialize: 1 });
});

test('incomplete status cannot enable operations; changed UID or account mapping stays blocked', async () => {
  for (const changed of ['uid', 'uin']) {
    const f = nativeFixture(); await f.agent.run({ ...f.input, operation: 'connect' });
    for (const info of [{ status: 10 }, { uid: 'u_test' }, null, { uid: 'u_test', status: 0 }]) {
      f.emit(info); assert.throws(() => f.guarded().getMsgService(), /selected_account_offline/);
      f.emit({ uid: 'u_test', status: 50 }); f.guarded().getMsgService();
    }
    f.mapAccount(''); f.emit({ uid: 'u_test', status: 10 });
    assert.throws(() => f.guarded().getMsgService(), /selected_account_offline/);
    f.mapAccount('100001'); f.emit({ uid: 'u_test', status: 10 }); f.guarded().getMsgService();
    if (changed === 'uin') f.mapAccount('100002');
    f.emit({ uid: changed === 'uid' ? 'other' : 'u_test', status: 10 });
    f.mapAccount('100001'); f.emit({ uid: 'u_test', status: 10 });
    assert.throws(() => f.guarded().getMsgService(), /selected_account_offline/);
    await assert.rejects(f.agent.run({ ...f.input, operation: 'connect' }), /bridge_changed/);
    assert.deepEqual(f.counts(), { nativeLogins: 0, initialize: 1 });
  }
});

test('failed framework is never revived by online events or reconnect', async () => {
  const f = nativeFixture(); await f.agent.run({ ...f.input, operation: 'connect' });
  const state = (f.globals as any)[Symbol.for('whalelife.qq.desktop-attach.v1')];
  state.failed = true; f.emit({ uid: 'u_test', status: 10 });
  assert.throws(() => f.guarded().getMsgService(), /selected_account_offline/);
  await assert.rejects(f.agent.run({ ...f.input, operation: 'connect' }), /bridge_changed/);
});

test('concurrent connects await a single initialization', async () => {
  const f = nativeFixture();
  await Promise.all(Array.from({ length: 3 }, () => f.agent.run({ ...f.input, operation: 'connect' })));
  assert.deepEqual(f.counts(), { nativeLogins: 0, initialize: 1 }); assert.equal(f.listeners.size, 1);
  f.guarded().getMsgService().sendMsg(); assert.deepEqual(f.events, ['sent']);
});

test('live v1 upgrade repairs the existing proxies, keeps one framework, and does not duplicate recovery listeners', async () => {
  // Frozen 0.14.1 agent, rather than an imitation of the old guard.
  const old = createRequire(import.meta.url)('./fixtures/desktop-agent-v1.cjs');
  const f = nativeFixture(old.createAgent); await f.agent.run({ ...f.input, operation: 'connect' });
  const messages = f.guarded().getMsgService(); let received = 0;
  messages.addKernelMsgListener({ onMessage() { received++; } });
  f.emit({ uid: 'u_test', status: 20 }); f.emit({ uid: 'u_test', status: 10 });
  assert.throws(() => messages.sendMsg(), /selected_account_offline/);
  await assert.rejects(f.agent.run({ ...f.input, operation: 'connect' }), /bridge_changed/);
  for (let i = 0; i < 3; i++) {
    await f.upgrade().run({ ...f.input, operation: 'connect' });
    assert.equal(f.listeners.size, 2); // Original listener plus one recovery monitor.
    f.emit({ uid: 'u_test', status: 20 });
    assert.throws(() => messages.sendMsg(), /selected_account_offline/);
    f.emitMessage(); assert.equal(received, i);
    f.emit({ uid: 'u_test', status: 10 }); messages.sendMsg(); f.emitMessage();
  }
  assert.equal(received, 3); assert.equal(f.events.length, 3);
  assert.deepEqual(f.counts(), { nativeLogins: 0, initialize: 1 });
  f.emit({ uid: 'other', status: 10 }); f.emit({ uid: 'u_test', status: 10 });
  await assert.rejects(f.upgrade().run({ ...f.input, operation: 'connect' }), /bridge_changed/);
  assert.throws(() => messages.sendMsg(), /selected_account_offline/);
});

test('late attach uses existing native session without QR, login, init or desktop restart; repeated connect loads once', async () => {
  const f = nativeFixture();
  const self = await f.agent.run({ ...f.input, operation: 'inspect' });
  assert.equal(self.accountId, '100001'); assert.equal(f.listeners.size, 0);
  await f.agent.run({ ...f.input, operation: 'connect' });
  await f.agent.run({ ...f.input, operation: 'connect' });
  assert.deepEqual(f.counts(), { nativeLogins: 0, initialize: 1 });
  f.guarded().getMsgService().sendMsg(); assert.deepEqual(f.events, ['sent']);
  for (const listener of f.listeners.values()) listener.onSelfStatusChanged({ uid: 'different', status: 10 });
  assert.throws(() => f.guarded().getMsgService().sendMsg(), /selected_account_offline/);
  assert.deepEqual(f.events, ['sent']);
});

test('existing owned bridge is reused; foreign bridge and changed account do not initialize a second bridge', async () => {
  const f = nativeFixture(); f.runtime.env.NAPCAT_WORKDIR = f.input.legacyWorkdir;
  assert.equal((await f.agent.run({ ...f.input, operation: 'connect' })).bridge, 'legacy');
  assert.deepEqual(f.counts(), { nativeLogins: 0, initialize: 0 });
  f.runtime.env.NAPCAT_WORKDIR = 'C:\\other';
  await assert.rejects(f.agent.run({ ...f.input, operation: 'connect' }), /foreign_bridge/);
  await assert.rejects(f.agent.run({ ...f.input, accountId: '100002', operation: 'connect' }), /account_changed/);
  assert.equal(f.listeners.size, 0);
});

test('new mode permits account selection, keeps legacy defaults and renders valid script', () => {
  assert.equal(config.accountId, ''); assert.equal(parseConfig({}).connectionMode, 'desktop');
  assert.notEqual(processKey(processInfo), processKey({ ...processInfo, startedAt: 'other' }));
  assert.ok(page.includes('连接所选 QQ')); assert.ok(page.includes('打开桌面 QQ'));
  new Function(script);
});
