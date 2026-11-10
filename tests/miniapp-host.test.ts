/*! Copyright (c) 2026 iinukami and contributors.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile, readdir, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { fixture, until } from './fixture.ts';
import { temporaryDirectory } from './temporary-directory.ts';
import { segmentationDefaults } from '../src/config.ts';

type Fixture = Awaited<ReturnType<typeof fixture>>;
const sends = (f: Fixture) => f.calls.filter(c => c.action === 'send_private_msg');
const generations = (f: Fixture) => f.calls.filter(c => c.action === 'get_mini_app_ark');
const payload = { userId: '200002', actionId: 'bilibili:host-test', personaId: 'a', preset: 'bili',
  title: 'Synthetic transient video title', description: 'Synthetic transient video description',
  previewUrl: 'https://i0.hdslb.com/bfs/archive/synthetic-only.jpg', jumpPath: 'pages/video/video?avid=123456',
  webUrl: 'https://www.bilibili.com/video/BV1GJ411x7h7/' };
const signed = () => ({ app: 'com.tencent.miniapp_01', ver: '1.0.0.0', view: 'miniapp', config: { token: 'synthetic-qq-signed-token', ctime: 1234567890 },
  meta: { detail_1: { appid: '1109937557', scene: 0, url: payload.jumpPath, title: payload.title, desc: payload.description,
    preview: payload.previewUrl, host: { uin: 100001, nick: 'synthetic-qq-host-identity' } } }, miniappShareOrigin: 3, miniappOpenRefer: '10002' });
function installArk(f: Fixture, hook?: (data: any, socket: any) => boolean | Promise<boolean>) {
  f.setAction(async (data, socket) => {
    if (hook && await hook(data, socket)) return true;
    if (data.action !== 'get_mini_app_ark') return false;
    socket.send(JSON.stringify({ status: 'ok', retcode: 0, echo: data.echo, data: { data: signed() } })); return true;
  });
}
async function setup(t: Parameters<typeof fixture>[0], hostBoot?: any, config = {}) {
  const f = await fixture(t, { temporaryDirectory, hostBoot, config: { permission: 'full', galleryEnabled: false, ...config } });
  await f.online();
  const sessionId = await f.app.sessions.create('synthetic card share session');
  installArk(f);
  const service = () => f.app.runtime.services.get('qq')!.value;
  const input = { ...payload, sessionId };
  const send = (patch = {}, options: any = { permission: 'full' }) => service().sendMiniAppShare({ ...input, ...patch }, options);
  const status = () => service().miniAppShareDelivery({ userId: input.userId, actionId: input.actionId, sessionId });
  return { f, sessionId, service, input, send, status };
}

for (const baseline of ['current', '213b52b']) test(`mini-app public service on ${baseline}: signed JSON, privacy, session pinning, dedup and reload`, { timeout: 45000 }, async t => {
  let hostBoot;
  if (baseline !== 'current') {
    const dir = await temporaryDirectory('whale-qq-miniapp-host-');
    const host = fileURLToPath(new URL('../../whalelife', import.meta.url));
    const gitArgs = ['-c', `safe.directory=${host.replaceAll('\\', '/')}`, '-C', host];
    const commit = execFileSync('git', [...gitArgs, 'rev-parse', 'refs/tags/213b52b^{commit}'], { encoding: 'utf8' }).trim();
    assert.equal(commit, '7c8e3898b2bc7cb0b892eb0ab2feec0ca9c8aaf0');
    execFileSync('git', [...gitArgs, 'archive', '--format=tar', '--output=' + join(dir, 'host.tar'), commit, 'core', 'package.json']);
    execFileSync('tar', ['-xf', join(dir, 'host.tar'), '-C', dir]);
    await symlink(join(host, 'node_modules'), join(dir, 'node_modules'), 'junction');
    hostBoot = (await import(pathToFileURL(join(dir, 'core/index.ts')).href)).boot;
  }
  const { f, sessionId, service, send, status } = await setup(t, hostBoot);
  assert.equal(service().miniAppShareApiVersion, '1.0.0');
  const current = typeof f.app.sessions.current === 'function' ? await f.app.sessions.current() : undefined;
  assert.equal((await status()).status, 'not_found');
  const [first, duplicate] = await Promise.all([send(), send()]);
  assert.equal(first.status, 'sent'); assert.equal(first.confirmed, true); assert.equal(first.platformMessageId, '9000');
  assert.equal(duplicate.status, 'sent'); assert.equal(duplicate.confirmed, true); assert.equal(duplicate.platformMessageId, '9000');
  // Public RPC requests may arrive in either order. Exactly one is the initial
  // call and the other must be a duplicate, with a single platform dispatch.
  assert.deepEqual([first.duplicate, duplicate.duplicate].sort(), [false, true], JSON.stringify([first, duplicate]));
  assert.equal((await send()).duplicate, true);
  assert.equal(generations(f).length, 1); assert.equal(sends(f).length, 1);
  assert.deepEqual(generations(f)[0].params, { type: 'bili', title: payload.title, desc: payload.description, picUrl: payload.previewUrl, jumpUrl: payload.jumpPath, webUrl: payload.webUrl });
  const mobileCard = signed(); mobileCard.meta.detail_1.scene = 1036;
  assert.deepEqual(sends(f)[0].params.message, [{ type: 'json', data: { data: JSON.stringify(mobileCard) } }]);
  assert.equal((await send({ title: 'Changed title' })).error, 'conflict'); assert.equal(sends(f).length, 1);
  assert.equal((await status()).status, 'sent');
  if (current) assert.equal(await f.app.sessions.current(), current);
  const dataDir = join(f.root, 'plugins/qq/data'), names = await readdir(dataDir);
  const ledgerNames = names.filter(name => name.startsWith('miniapp-delivery-'));
  assert.equal(ledgerNames.length, 1); assert.equal(names.some(name => name.startsWith('media-delivery-')), false);
  const ledger = await readFile(join(dataDir, ledgerNames[0]), 'utf8');
  const rows = await f.app.memory.readSession(sessionId), memory = await f.app.memoryEngine.state(sessionId);
  const durable = ledger + JSON.stringify(rows) + JSON.stringify(memory);
  for (const secret of [payload.title, payload.description, payload.previewUrl, payload.jumpPath, payload.webUrl, 'synthetic-qq-signed-token', 'synthetic-qq-host-identity']) assert.ok(!durable.includes(secret), secret);
  assert.equal(memory.records.filter((row: any) => row.source === 'qq' && row.text === '已通过 QQ 私聊发送一张 B 站视频小程序卡片。').length, 1);
  await f.app.runtime.action('qq', 'reload'); await f.online();
  assert.equal((await send()).status, 'sent'); assert.equal((await send()).duplicate, true); assert.equal(sends(f).length, 1);
  assert.equal(f.generations.length, 0); assert.equal(f.modelCalls.length, 0);
  assert.equal(await f.app.runtime.services.get('witness')!.value.ping(), 'alive');
});

test('mini-app public service rejects permissions, missing sessions, non-whitelisted targets and arbitrary fields', async t => {
  const { f, send } = await setup(t);
  for (const [patch, options, code] of [
    [{}, { permission: 'safe' }, 'permission'], [{ sessionId: 'missing-session' }, { permission: 'full' }, 'session'],
    [{ userId: '300003' }, { permission: 'full' }, 'recipient'], [{ rawArkData: '{}' }, { permission: 'full' }, 'invalid_input'],
  ] as const) assert.equal((await send(patch, options)).error, code);
  assert.equal(generations(f).length, 0); assert.equal(sends(f).length, 0);
  await f.save({ permission: 'off' }); await f.online(); assert.equal((await send()).error, 'permission');
});

test('unsupported signing and mismatch never reach send; failed sends remain uncertain with no text fallback', async t => {
  const { f, send } = await setup(t);
  for (const mode of ['unsupported', 'mismatch', 'platform-failed', 'missing-id', 'timeout']) {
    installArk(f, (data, socket) => {
      if (data.action === 'get_mini_app_ark' && mode === 'unsupported') {
        socket.send(JSON.stringify({ status: 'failed', retcode: 1400, message: 'private token', echo: data.echo })); return true;
      }
      if (data.action === 'get_mini_app_ark' && mode === 'mismatch') {
        const value = signed(); value.meta.detail_1.url = 'wrong-target';
        socket.send(JSON.stringify({ status: 'ok', retcode: 0, data: { data: value }, echo: data.echo })); return true;
      }
      if (data.action === 'send_private_msg') {
        if (mode !== 'timeout') socket.send(JSON.stringify({ status: mode === 'platform-failed' ? 'failed' : 'ok', retcode: mode === 'platform-failed' ? 1200 : 0, data: {}, echo: data.echo }));
        return true;
      }
      return false;
    });
    const patch = { actionId: `bilibili:${mode}` }; const before = sends(f).length;
    const result = await send(patch); assert.equal(result.status, ['unsupported', 'mismatch'].includes(mode) ? 'not_sent' : 'uncertain');
    assert.ok(!JSON.stringify(result).includes('private')); assert.equal(result.canRetry, false);
    assert.equal((await send(patch)).duplicate, true); assert.equal(sends(f).length - before, ['unsupported', 'mismatch'].includes(mode) ? 0 : 1);
  }
  assert.ok(sends(f).every(call => call.params.message[0].type === 'json'));
});

test('reload during signing cancels before send, and reload after dispatch prevents replay', async t => {
  const { f, send, status } = await setup(t);
  let generating = false;
  installArk(f, data => { if (data.action === 'get_mini_app_ark') { generating = true; return true; } return false; });
  const pending = send(); await until(() => generating);
  await f.app.runtime.action('qq', 'reload'); await pending.catch(() => {}); await f.online();
  assert.equal(sends(f).length, 0); assert.equal((await status()).status, 'not_sent');
  installArk(f, data => data.action === 'send_private_msg');
  const second = send({ actionId: 'bilibili:after-dispatch' }); await until(() => sends(f).length === 1);
  await f.app.runtime.action('qq', 'reload'); await second.catch(() => {}); await f.online();
  const duplicate = await send({ actionId: 'bilibili:after-dispatch' }); assert.equal(duplicate.status, 'uncertain'); assert.equal(duplicate.duplicate, true);
  assert.equal(sends(f).length, 1); assert.equal(f.generations.length, 0); assert.equal(f.modelCalls.length, 0);
});

test('another active inbound session blocks card generation without rebind or send', { timeout: 15000 }, async t => {
  const { f, send } = await setup(t);
  let started = false, release: (() => void) | undefined;
  f.setGenerate(async () => { started = true; await new Promise<void>(resolve => { release = resolve; }); return { text: 'synthetic final reply', toolCalls: [] }; });
  // Incoming traffic follows the existing current session, distinct from the
  // explicit session created by setup for the outgoing public-service call.
  const current = await f.app.sessions.current();
  const other = await f.app.sessions.create('other isolated share target');
  try {
    f.send(); await until(() => started);
    assert.equal((await send({ sessionId: other })).error, 'binding'); assert.equal(generations(f).length, 0); assert.equal(sends(f).length, 0);
    assert.equal(await f.app.sessions.current(), current);
  } finally { release?.(); }
  await until(() => sends(f).length === 1);
});

test('same-session share seals inbound additions and uses the existing outbound queue', { timeout: 18000 }, async t => {
  let release: (() => void) | undefined;
  t.after(() => release?.());
  const { f, send } = await setup(t);
  const current = await f.app.sessions.current(); let generated = 0, cardSent = false;
  f.setGenerate(async () => {
    if (++generated === 1) {
      const result = await send({ sessionId: current }); assert.equal(result.status, 'sent'); cardSent = true;
      await new Promise<void>(resolve => { release = resolve; });
    }
    return { text: 'synthetic final reply', toolCalls: [] };
  });
  try {
    f.send(); await until(() => cardSent);
    f.send({ message_id: 2 });
    await until(async () => (await f.status()).recent.some((row: any) => row.status === 'next_turn'));
    assert.equal(generated, 1); assert.deepEqual(sends(f).map(call => call.params.message[0].type), ['json']);
  } finally { release?.(); }
  await until(() => sends(f).length === 3);
  assert.deepEqual(sends(f).map(call => call.params.message[0].type), ['json', 'text', 'text']);
  assert.equal(generations(f).length, 1);
});

test('bounded card queue rejects excess work and cancellation before dispatch leaves no JSON send', { timeout: 15000 }, async t => {
  const { f, send } = await setup(t); let first = true;
  installArk(f, data => { if (data.action === 'get_mini_app_ark' && first) { first = false; return true; } return false; });
  const controller = new AbortController();
  const pending = send({}, { permission: 'full', signal: controller.signal });
  await until(() => generations(f).length === 1);
  const queued = send({ actionId: 'bilibili:second' });
  await until(async () => (await f.status()).queued === 2);
  assert.equal((await send({ actionId: 'bilibili:third' })).error, 'busy');
  controller.abort();
  assert.equal((await pending).status, 'not_sent'); assert.equal((await queued).status, 'sent');
  assert.equal(generations(f).length, 2); assert.equal(sends(f).length, 1);
});

test('failed card preparation keeps supplements in the same active turn', { timeout: 18000 }, async t => {
  let release: (() => void) | undefined;
  t.after(() => release?.());
  const { f, send } = await setup(t, undefined, { requestTimeoutMs: 10000 });
  const current = await f.app.sessions.current(); let rounds = 0;
  installArk(f, (data, socket) => {
    if (data.action !== 'get_mini_app_ark') return false;
    release = () => socket.send(JSON.stringify({ status: 'failed', retcode: 1400, echo: data.echo }));
    return true;
  });
  f.setGenerate(async input => {
    if (++rounds === 1) {
      assert.equal((await send({ sessionId: current })).status, 'not_sent');
      return { text: 'STALE_PREPARATION_REPLY', toolCalls: [] };
    }
    assert.ok(JSON.stringify(input.messages).includes('LATEST_SUPPLEMENT'));
    return { text: '按补充回复', toolCalls: [] };
  });
  f.send(); await until(() => release);
  f.send({ message_id: 2, message: [{ type: 'text', data: { text: 'LATEST_SUPPLEMENT' } }] });
  await until(async () => (await f.status()).recent.some((row: any) => row.messageId === '2' && row.status === 'merged'), 2000);
  assert.equal(sends(f).length, 0); release!();
  await until(async () => (await f.status()).queued === 0);
  assert.equal(rounds, 2);
  assert.deepEqual(sends(f).map(call => call.params.message[0].data.text), ['按补充回复']);
  const rows = await f.app.memory.readSession(current);
  assert.equal(rows.filter((row: any) => row.role === 'assistant').length, 1);
  assert.equal(rows.filter((row: any) => row.role === 'user').length, 2);
});

test('slow card preparation does not block ordinary segmented replies without Bilibili installed', { timeout: 18000 }, async t => {
  let release: (() => void) | undefined;
  t.after(() => release?.());
  const { f, send } = await setup(t, undefined, { requestTimeoutMs: 10000,
    segmentedReply: { ...segmentationDefaults, enabled: true, interval: '0,0' } });
  assert.equal(f.app.runtime.records.has('bilibili'), false);
  assert.equal(f.app.runtime.records.has('surf'), false);
  installArk(f, (data, socket) => {
    if (data.action !== 'get_mini_app_ark') return false;
    release = () => socket.send(JSON.stringify({ status: 'ok', retcode: 0, data: { data: signed() }, echo: data.echo }));
    return true;
  });
  const card = send(); await until(() => release);
  f.setGenerate(async () => ({ text: '第一句。第二句。第三句。', toolCalls: [] }));
  f.send(); await until(() => sends(f).length === 3, 2000);
  await until(async () => (await f.status()).recent.some((row: any) => row.status === 'sent'));
  assert.deepEqual(sends(f).map(call => call.params.message[0].data.text), ['第一句。', '第二句。', '第三句。']);
  release!(); assert.equal((await card).status, 'sent');
  assert.deepEqual(sends(f).map(call => call.params.message[0].type), ['text', 'text', 'text', 'json']);
});

test('ready card waits for the entire segmented delivery and a failed card leaves the queue usable', { timeout: 18000 }, async t => {
  let releaseText: (() => void) | undefined, releaseCard: (() => void) | undefined;
  t.after(() => { releaseText?.(); releaseCard?.(); });
  const { f, send } = await setup(t, undefined, { requestTimeoutMs: 10000,
    segmentedReply: { ...segmentationDefaults, enabled: true, interval: '0,0' } });
  const current = await f.app.sessions.current();
  installArk(f, (data, socket) => {
    if (data.action === 'get_mini_app_ark') {
      releaseCard = () => socket.send(JSON.stringify({ status: 'ok', retcode: 0, data: { data: signed() }, echo: data.echo }));
      return true;
    }
    if (data.action === 'send_private_msg' && data.params.message[0].type === 'json') {
      socket.send(JSON.stringify({ status: 'failed', retcode: 1200, echo: data.echo })); return true;
    }
    if (data.action === 'send_private_msg' && !releaseText) {
      releaseText = () => socket.send(JSON.stringify({ status: 'ok', retcode: 0, data: { message_id: 7777 }, echo: data.echo }));
      return true;
    }
    return false;
  });
  const card = send({ sessionId: current }); await until(() => releaseCard);
  f.setGenerate(async () => ({ text: '甲。乙。丙。', toolCalls: [] }));
  f.send(); await until(() => releaseText, 2000);
  releaseCard!();
  assert.equal(sends(f).length, 1);
  releaseText!(); assert.equal((await card).status, 'uncertain');
  assert.deepEqual(sends(f).map(call => call.params.message[0].type), ['text', 'text', 'text', 'json']);
  f.setGenerate(async () => ({ text: '仍然正常。', toolCalls: [] }));
  f.send({ message_id: 2 }); await until(() => sends(f).length === 5);
  assert.equal(sends(f)[4].params.message[0].data.text, '仍然正常。');
  assert.equal((await send({ sessionId: current })).duplicate, true);
  assert.equal(sends(f).length, 5);
});
