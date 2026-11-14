/*! Copyright (c) 2026 iinukami and contributors.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile, readdir, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { temporaryDirectory } from '../../whalelife/tests/temporary-directory.ts';
const { installDiagnostics, createDiagnosticsInstaller } = createRequire(import.meta.url)('../attach/diagnostics.cjs');

function fixture(writeSnapshot?: (workdir: string, snapshot: any) => Promise<void>) {
  const state: any = { uid: 'u_fake_private_identity', accountId: '123456789', valid: true, failed: false };
  const profiles: any[] = [], messages: any[] = [], snapshots: any[] = [];
  let sent = 0;
  const session = {
    getProfileService: () => ({ addKernelProfileListener(listener: any) { profiles.push(listener); } }),
    getMsgService: () => ({ addKernelMsgListener(listener: any) { messages.push(listener); }, sendMsg() { sent++; } }),
  };
  const installer = createDiagnosticsInstaller({
    now: () => '2026-01-01T00:00:00.000Z',
    writeSnapshot: writeSnapshot ?? (async (_workdir: string, snapshot: any) => { snapshots.push(snapshot); }),
  });
  const connect = () => installer(state, session, 'C:\\fake-workdir');
  return { state, profiles, messages, session, snapshots, connect, sent: () => sent,
    status: (status: number, extra: any = {}) => { for (const listener of profiles) listener.onSelfStatusChanged({ uid: state.uid, status, ...extra }); },
    kick: (info: any = {}) => { for (const listener of messages) listener.onKickedOffLine(info); },
  };
}

test('raw diagnostic observers retain both callback orders without reviving guarded business', async () => {
  for (const order of [['status', 'kick'], ['kick', 'status']]) {
    const f = fixture();
    // Existing identity monitor is registered before diagnostics and business.
    f.profiles.push({ onSelfStatusChanged: (info: any) => { f.state.valid = info.status !== 20; } });
    const diagnostics = f.connect();
    let upstream = 0;
    f.profiles.push({ onSelfStatusChanged: () => { if (f.state.valid) upstream++; } });
    f.messages.push({ onKickedOffLine: () => { if (f.state.valid) upstream++; } });
    for (const event of order) event === 'status' ? f.status(20) : f.kick({ kickedType: 1, securityKickedType: 2, sameDevice: false });
    await diagnostics.flush();
    assert.deepEqual(diagnostics.events.slice(1).map((event: any) => event.event), order.map(event => event === 'kick' ? 'kicked' : event));
    assert.equal(f.state.valid, false); assert.equal(f.state.failed, false);
    assert.equal(upstream, order[0] === 'kick' ? 1 : 0);
    assert.equal(f.sent(), 0);
  }
});

test('status deduplication and recovery preserve observations without changing identity state', async () => {
  const f = fixture(), diagnostics = f.connect();
  for (const status of [10, 10, 20, 20, 10, 10]) f.status(status);
  f.status(Number.NaN); f.status(1.5);
  await diagnostics.flush();
  assert.deepEqual(diagnostics.events.filter((event: any) => event.event === 'status').map((event: any) => event.status), [10, 20, 10]);
  assert.equal(f.state.valid, true); assert.equal(f.state.failed, false);
});

test('diagnostics retain only fixed categories and typed codes, never server text or identity', async () => {
  const f = fixture(), diagnostics = f.connect();
  const secret = 'PRIVATE_TOKEN_abc user@example.invalid 192.0.2.1 https://example.invalid/?token=secret';
  const common = { uid: f.state.uid, accountId: f.state.accountId, appId: 123, instanceId: 456, token: secret };
  f.status(20, { ...common, customStatus: secret });
  for (const [tipsDesc, expected] of [
    [`用户身份已失效 ${secret}`, 'login_invalid'], [`已在其他设备登录 ${secret}`, 'other_device'],
    [`存在安全风险 ${secret}`, 'security'], [`${secret}`, 'unknown'],
  ]) {
    f.kick({ ...common, tipsTitle: secret, tipsDesc, kickedType: 7, securityKickedType: 8, sameDevice: false });
    assert.equal(diagnostics.events.at(-1).reason, expected);
  }
  f.kick({ kickedType: 'secret-code', securityKickedType: Infinity, sameDevice: secret });
  await diagnostics.flush();
  const serialized = JSON.stringify(f.snapshots);
  for (const privateValue of [secret, f.state.uid, f.state.accountId, 'tipsDesc', 'tipsTitle', 'appId', 'instanceId', 'secret-code'])
    assert.ok(!serialized.includes(privateValue), privateValue);
  assert.deepEqual(Object.keys(diagnostics.events.at(-1)).sort(), ['at', 'event', 'reason']);
  const permitted = new Set(['at', 'event', 'status', 'reason', 'kickedType', 'securityKickedType', 'sameDevice']);
  for (const event of diagnostics.events) for (const key of Object.keys(event)) assert.ok(permitted.has(key), key);
});

test('account change ends collection permanently while allowing identity-free kicks before change', async () => {
  for (const byState of [false, true]) {
    const f = fixture(), diagnostics = f.connect();
    f.kick({ tipsDesc: '用户身份失效' });
    assert.equal(diagnostics.events.at(-1).event, 'kicked');
    if (byState) { f.state.accountChanged = true; f.kick(); }
    else f.status(10, { uid: 'different-private-uid' });
    const length = diagnostics.events.length;
    f.state.accountChanged = false;
    f.status(10); f.kick({ tipsDesc: 'do not retain this account' }); f.connect();
    await diagnostics.flush();
    assert.equal(diagnostics.events.length, length);
    assert.equal(diagnostics.events.at(-1).event, 'account_changed');
    assert.equal(f.state.valid, true);
    assert.ok(!JSON.stringify(f.snapshots).includes('different-private-uid'));
  }
});

test('existing owned state and repeated installs add one pair of observers without touching business', async () => {
  const f = fixture();
  const existingMonitor = { id: 42 }; f.state.identityMonitor = existingMonitor;
  const diagnostics = f.connect();
  for (let i = 0; i < 5; i++) assert.equal(f.connect(), diagnostics);
  assert.equal(f.profiles.length, 1); assert.equal(f.messages.length, 1);
  assert.equal(diagnostics.observerState, 'ready'); assert.equal(f.state.identityMonitor, existingMonitor);
  await diagnostics.flush();
  assert.equal(diagnostics.events.filter((event: any) => event.event === 'attached').length, 1);
});

test('registration failure is nonfatal and a later install retries only missing observers', async () => {
  const f = fixture(); let attempts = 0;
  f.session.getMsgService = () => ({ addKernelMsgListener(listener: any) {
    if (++attempts === 1) throw Error('native listener unavailable'); f.messages.push(listener);
  }, sendMsg() {} });
  const diagnostics = f.connect();
  assert.equal(diagnostics.observerState, 'partial');
  await diagnostics.flush();
  assert.equal(f.snapshots.at(-1).observerState, 'partial');
  f.connect(); f.connect();
  assert.equal(diagnostics.observerState, 'ready'); assert.equal(attempts, 2);
  assert.equal(f.profiles.length, 1); assert.equal(f.messages.length, 1);
  assert.equal(f.state.valid, true); await diagnostics.flush();
  assert.deepEqual(f.snapshots.map(snapshot => snapshot.observerState), ['partial', 'ready']);
});

test('write failures stay fixed-status only and cannot block business or callback dispatch', async () => {
  let fail = true;
  const f = fixture(async () => { if (fail) throw Error('private-path private-token'); });
  const diagnostics = f.connect();
  f.status(20); f.kick(); await diagnostics.flush();
  assert.equal(diagnostics.writeState, 'failed');
  f.session.getMsgService().sendMsg(); assert.equal(f.sent(), 1);
  assert.equal(f.state.valid, true); assert.equal(f.state.failed, false);
  assert.ok(!JSON.stringify(diagnostics).includes('private-token'));
  fail = false; f.status(10); await diagnostics.flush();
  assert.equal(diagnostics.writeState, 'ok');
});

test('slow storage coalesces a large event burst into a bounded tail and one pending snapshot', async () => {
  let release!: () => void, started!: () => void, writes = 0, active = 0, maximumActive = 0;
  const began = new Promise<void>(resolve => { started = resolve; });
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const snapshots: any[] = [];
  const f = fixture(async (_workdir, snapshot) => {
    writes++; active++; maximumActive = Math.max(maximumActive, active); snapshots.push(snapshot);
    if (writes === 1) { started(); await blocked; }
    active--;
  });
  const diagnostics = f.connect(); await began;
  for (let i = 0; i < 1000; i++) f.status(i % 2 === 0 ? 10 : 20);
  assert.equal(diagnostics.events.length, 32); assert.equal(writes, 1);
  release(); await diagnostics.flush();
  assert.equal(writes, 2); assert.equal(maximumActive, 1);
  assert.equal(snapshots.at(-1).events.length, 32);
  assert.equal(snapshots.at(-1).events.at(-1).status, 20);
});

test('ordinary messages are ignored and native callback access errors do not escape', async () => {
  const f = fixture(), diagnostics = f.connect();
  f.messages[0].onRecvMsg({ body: 'PRIVATE_MESSAGE_BODY' });
  f.messages[0].onAddSendMsg({ body: 'PRIVATE_MESSAGE_BODY' });
  const invalid = Object.defineProperty({}, 'tipsTitle', { get() { throw Error('bad callback data'); } });
  assert.doesNotThrow(() => f.kick(invalid));
  await diagnostics.flush();
  assert.deepEqual(diagnostics.events.map((event: any) => event.event), ['attached']);
  assert.equal(f.state.valid, true);
});

test('default writer creates an atomic bounded file in a registered isolated directory', async () => {
  const directory = await temporaryDirectory('whale-qq-diagnostics-');
  const f = fixture();
  const diagnostics = installDiagnostics(f.state, f.session, directory);
  f.status(20); f.kick({ tipsDesc: '用户身份失效', kickedType: 7 });
  await diagnostics.flush();
  assert.equal(diagnostics.writeState, 'ok');
  const saved = JSON.parse(await readFile(join(directory, 'connection-diagnostics.json'), 'utf8'));
  assert.equal(saved.observerState, 'ready');
  assert.deepEqual(saved.events.map((event: any) => event.event), ['attached', 'status', 'kicked']);
  assert.deepEqual(await readdir(directory), ['connection-diagnostics.json']);
  assert.ok(!JSON.stringify(saved).includes(f.state.uid));
});

test('default writer rejects a linked work directory without creating logs in its target', async () => {
  const directory = await temporaryDirectory('whale-qq-diagnostics-link-');
  const target = await temporaryDirectory('whale-qq-diagnostics-target-');
  const linked = join(directory, 'linked');
  await symlink(target, linked, process.platform === 'win32' ? 'junction' : 'dir');
  const f = fixture(), diagnostics = installDiagnostics(f.state, f.session, linked);
  f.status(20); await diagnostics.flush();
  assert.equal(diagnostics.writeState, 'failed');
  assert.deepEqual(await readdir(target), []);
  assert.equal(f.state.valid, true);
});

test('Windows workdir casing differences remain valid while link checks stay active', { skip: process.platform !== 'win32' }, async () => {
  const directory = await temporaryDirectory('whale-qq-diagnostics-case-');
  const workdir = directory[0]!.toLowerCase() + directory.slice(1).toUpperCase();
  assert.notEqual(workdir, directory);
  const f = fixture(), diagnostics = installDiagnostics(f.state, f.session, workdir);
  f.status(20); await diagnostics.flush();
  assert.equal(diagnostics.writeState, 'ok');
  const saved = JSON.parse(await readFile(join(directory, 'connection-diagnostics.json'), 'utf8'));
  assert.deepEqual(saved.events.map((event: any) => event.event), ['attached', 'status']);
  assert.deepEqual(await readdir(directory), ['connection-diagnostics.json']);
});
