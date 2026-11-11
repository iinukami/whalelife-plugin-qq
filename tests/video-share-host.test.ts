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
const sends = (f: Fixture) => f.calls.filter(call => call.action === 'send_private_msg');
const signing = (f: Fixture) => f.calls.filter(call => call.action === 'get_mini_app_ark');
const payload = { userId: '200002', actionId: 'bilibili:video-host', personaId: 'a', preset: 'bili',
  title: 'Synthetic private video title。保留完整。', description: 'Synthetic private video description',
  previewUrl: '', jumpPath: 'pages/video/video?avid=123456', webUrl: 'https://www.bilibili.com/video/BV1GJ411x7h7/' };
const coverUrl = 'https://i0.hdslb.com/bfs/archive/synthetic-video-cover.png';
const expectedText = [payload.title, payload.description, payload.webUrl].join('\n');
const signed = () => ({ app: 'com.tencent.miniapp_01', config: { token: 'synthetic-private-signature', ctime: 1 },
  meta: { detail_1: { appid: '1109937557', url: payload.jumpPath, title: payload.title,
    desc: payload.description, preview: coverUrl, host: { nick: 'synthetic-private-host' } } } });

async function setup(t: Parameters<typeof fixture>[0], hostBoot?: any, config = {}) {
  const f = await fixture(t, { temporaryDirectory, hostBoot, config: { permission: 'full', galleryEnabled: false,
    segmentedReply: { ...segmentationDefaults, enabled: true, onlyLLMResult: false, interval: '0,0',
      regex: '.*?[。./]+|.+$', maxLength: 500 }, ...config } });
  await f.online();
  f.setAction((data, socket) => {
    if (data.action !== 'get_mini_app_ark') return false;
    socket.send(JSON.stringify({ status: 'ok', retcode: 0, echo: data.echo, data: { data: signed() } })); return true;
  });
  const sessionId = await f.app.sessions.create('synthetic video-share session');
  const service = () => f.app.runtime.services.get('qq')!.value;
  const input = { ...payload, sessionId };
  const key = (actionId = input.actionId) => ({ userId: input.userId, actionId, sessionId });
  const send = (patch = {}, options: any = { permission: 'full' }) => service().sendVideoShare({ ...input, ...patch }, options);
  const legacy = (patch = {}) => service().sendMiniAppShare({ ...input, previewUrl: coverUrl, ...patch }, { permission: 'full' });
  return { f, service, sessionId, key, send, legacy };
}

for (const baseline of ['current', '213b52b']) test(`video-share service on ${baseline}: default card, old API, selection, privacy and shared dedup`,
  { timeout: 45000 }, async t => {
    let hostBoot;
    if (baseline !== 'current') {
      const dir = await temporaryDirectory('whale-qq-video-host-');
      const host = fileURLToPath(new URL('../../whalelife', import.meta.url));
      const gitArgs = ['-c', `safe.directory=${host.replaceAll('\\', '/')}`, '-C', host];
      const commit = execFileSync('git', [...gitArgs, 'rev-parse', 'refs/tags/213b52b^{commit}'], { encoding: 'utf8' }).trim();
      assert.equal(commit, '7c8e3898b2bc7cb0b892eb0ab2feec0ca9c8aaf0');
      execFileSync('git', [...gitArgs, 'archive', '--format=tar', '--output=' + join(dir, 'host.tar'), commit, 'core', 'package.json']);
      execFileSync('tar', ['-xf', join(dir, 'host.tar'), '-C', dir]);
      await symlink(join(host, 'node_modules'), join(dir, 'node_modules'), 'junction');
      hostBoot = (await import(pathToFileURL(join(dir, 'core/index.ts')).href)).boot;
    }
    const { f, service, sessionId, key, send, legacy } = await setup(t, hostBoot);
    assert.equal(service().videoShareApiVersion, '1.0.0'); assert.equal(service().miniAppShareApiVersion, '1.0.0');
    assert.equal((await f.configFile()).videoShareFormat, 'card');
    assert.equal(f.app.runtime.records.has('bilibili'), false); assert.equal(f.app.runtime.records.has('surf'), false);
    const current = typeof f.app.sessions.current === 'function' ? await f.app.sessions.current() : undefined;
    assert.equal((await service().videoShareDelivery(key())).status, 'not_found');
    const results = await Promise.all([send(), send()]);
    for (const result of results) {
      assert.equal(result.status, 'sent'); assert.equal(result.confirmed, true); assert.equal(result.format, 'card');
      assert.equal(result.coverIncluded, false); assert.equal(result.platformMessageId, '9000');
    }
    assert.deepEqual(results.map(result => result.duplicate).sort(), [false, true]);
    assert.equal(signing(f).length, 0); assert.equal(sends(f).length, 1);
    // The configured regex would split punctuation and URL slashes if sharing entered reply segmentation.
    assert.deepEqual(sends(f)[0].params.message, [{ type: 'text', data: { text: expectedText } }]);
    assert.equal((await service().miniAppShareDelivery(key())).error, 'conflict');
    assert.equal((await send({ title: 'changed title' })).error, 'conflict');
    await f.app.runtime.action('qq', 'reload'); await f.online();
    assert.equal((await send()).duplicate, true); assert.equal(sends(f).length, 1);

    const old = await legacy({ actionId: 'bilibili:legacy-compat' });
    assert.equal(old.status, 'sent'); assert.equal(Object.hasOwn(old, 'format'), false);
    assert.equal(Object.hasOwn(old, 'coverIncluded'), false); assert.equal(signing(f).length, 1);
    assert.equal((await service().videoShareDelivery(key('bilibili:legacy-compat'))).format, 'miniapp');
    // Same contents, different selected format: shared action ID must reject before image fetching.
    assert.equal((await send({ actionId: 'bilibili:legacy-compat', previewUrl: coverUrl })).error, 'conflict');
    assert.equal(sends(f).length, 2);

    assert.equal((await f.save({ videoShareFormat: 'miniapp' })).ok, true); await f.online();
    const found = await service().videoShareDelivery(key());
    assert.equal(found.format, 'card'); assert.equal(found.coverIncluded, false);
    const selected = await send({ actionId: 'bilibili:selected-miniapp', previewUrl: coverUrl });
    assert.equal(selected.status, 'sent'); assert.equal(selected.format, 'miniapp');
    assert.equal(Object.hasOwn(selected, 'coverIncluded'), false);
    assert.equal((await legacy({ actionId: 'bilibili:selected-miniapp' })).duplicate, true);
    assert.equal(signing(f).length, 2); assert.equal(sends(f).length, 3);
    assert.deepEqual(sends(f).slice(1).map(call => call.params.message),
      Array.from({ length: 2 }, () => [{ type: 'json', data: { data: JSON.stringify(signed()) } }]));
    if (current) assert.equal(await f.app.sessions.current(), current);

    const dataDir = join(f.root, 'plugins/qq/data'), names = await readdir(dataDir);
    const ledgers = names.filter(name => name.startsWith('miniapp-delivery-'));
    assert.equal(ledgers.length, 3); assert.equal(names.some(name => name.startsWith('media-delivery-')), false);
    const persisted = (await Promise.all(ledgers.map(name => readFile(join(dataDir, name), 'utf8')))).join('\n');
    const rows = await f.app.memory.readSession(sessionId), memory = await f.app.memoryEngine.state(sessionId);
    const durable = persisted + JSON.stringify(rows) + JSON.stringify(memory);
    for (const privateValue of [payload.title, payload.description, coverUrl, payload.jumpPath, payload.webUrl,
      'synthetic-private-signature', 'synthetic-private-host']) assert.ok(!durable.includes(privateValue), privateValue);
    assert.equal(memory.records.filter((row: any) => row.source === 'qq' && row.text === '已通过 QQ 私聊分享一个 B 站视频链接。').length, 1);
    assert.equal(f.generations.length, 0); assert.equal(f.modelCalls.length, 0);
    assert.equal(await f.app.runtime.services.get('witness')!.value.ping(), 'alive');
  });

test('video-share public service rejects invalid calls before preparation or sending', async t => {
  const { f, send, legacy } = await setup(t);
  for (const [patch, options, error] of [
    [{}, { permission: 'safe' }, 'permission'], [{ userId: '300003' }, { permission: 'full' }, 'recipient'],
    [{ userId: '100001' }, { permission: 'full' }, 'recipient'], [{ sessionId: 'missing-session' }, { permission: 'full' }, 'session'],
    [{ rawArkData: '{}' }, { permission: 'full' }, 'invalid_input'],
    [{ previewUrl: 'https://example.com/cover.png' }, { permission: 'full' }, 'invalid_input'],
    [{ webUrl: payload.webUrl + '?private=1' }, { permission: 'full' }, 'invalid_input'],
  ] as const) assert.equal((await send(patch, options)).error, error);
  assert.equal((await legacy({ previewUrl: '' })).error, 'invalid_input');
  assert.equal(signing(f).length, 0); assert.equal(sends(f).length, 0);
  assert.equal((await f.save({ permission: 'off' })).ok, true); await f.online();
  assert.equal((await send()).error, 'permission'); assert.equal(sends(f).length, 0);
});

test('failed or timed-out card dispatch never falls back or replays after reload', { timeout: 20000 }, async t => {
  const { f, send, service, key } = await setup(t);
  for (const mode of ['platform-failed', 'missing-id', 'timeout']) {
    f.setAction((data, socket) => {
      if (data.action !== 'send_private_msg') return false;
      if (mode !== 'timeout') socket.send(JSON.stringify({ status: mode === 'platform-failed' ? 'failed' : 'ok',
        retcode: mode === 'platform-failed' ? 1200 : 0, data: {}, message: 'private upstream body', echo: data.echo }));
      return true;
    });
    const actionId = 'bilibili:' + mode, before = sends(f).length;
    const result = await send({ actionId });
    assert.equal(result.status, 'uncertain'); assert.equal(result.format, 'card'); assert.equal(result.coverIncluded, false);
    assert.equal(result.retryAutomatically, false); assert.ok(!JSON.stringify(result).includes('private'));
    await f.app.runtime.action('qq', 'reload'); await f.online();
    assert.equal((await send({ actionId })).duplicate, true);
    assert.equal((await service().videoShareDelivery(key(actionId))).status, 'uncertain');
    assert.equal(sends(f).length, before + 1); assert.equal(signing(f).length, 0);
  }
  assert.ok(sends(f).every(call => call.params.message.length === 1 && call.params.message[0].data.text === expectedText));
});

test('reload after card dispatch keeps uncertain receipt without another send', { timeout: 15000 }, async t => {
  const { f, send, service, key } = await setup(t, undefined, { requestTimeoutMs: 10000 });
  f.setAction(data => data.action === 'send_private_msg');
  const pending = send(); await until(() => sends(f).length === 1);
  await f.app.runtime.action('qq', 'reload'); await pending.catch(() => {}); await f.online();
  const found = await service().videoShareDelivery(key());
  assert.equal(found.status, 'uncertain'); assert.equal(found.format, 'card'); assert.equal(found.coverIncluded, false);
  assert.equal((await send()).duplicate, true); assert.equal(sends(f).length, 1); assert.equal(signing(f).length, 0);
});

test('card waits behind a complete segmented reply and does not split its own URL', { timeout: 18000 }, async t => {
  let release: (() => void) | undefined;
  t.after(() => release?.());
  const { f, send } = await setup(t, undefined, { requestTimeoutMs: 10000,
    segmentedReply: { ...segmentationDefaults, enabled: true, interval: '0,0' } });
  const current = await f.app.sessions.current();
  f.setAction((data, socket) => {
    if (data.action !== 'send_private_msg' || release) return false;
    release = () => socket.send(JSON.stringify({ status: 'ok', retcode: 0, data: { message_id: 8777 }, echo: data.echo }));
    return true;
  });
  f.setGenerate(async () => ({ text: '甲。乙。丙。', toolCalls: [] }));
  f.send(); await until(() => release);
  const card = send({ sessionId: current });
  assert.equal(sends(f).length, 1); release!();
  assert.equal((await card).status, 'sent');
  assert.deepEqual(sends(f).map(call => call.params.message[0].data.text), ['甲。', '乙。', '丙。', expectedText]);
  assert.equal(signing(f).length, 0);
  assert.equal((await send({ sessionId: current })).duplicate, true); assert.equal(sends(f).length, 4);
});
