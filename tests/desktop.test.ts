import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { defaults, parseConfig } from '../src/config.ts';
import { DesktopBridge } from '../src/desktop-bridge.ts';
import { temporaryDirectory } from '../../whalelife/tests/temporary-directory.ts';
import { desktopConnection } from './desktop-fixture.ts';
import { fixture, until } from './fixture.ts';

test('desktop reuses a running bridge; disable, reload and stop never close it or replay replies', async t => {
  // No native vendor is in this fixture: connecting must not launch any QQ process.
  const f = await fixture(t, { config: { connectionMode: 'desktop' }, preparePlugin: desktopConnection });
  await f.online();
  assert.equal(f.calls[0].authorization, 'Bearer ' + 'a'.repeat(64));
  const stateFile = join(f.root, 'plugins/qq/data/desktop-bridge/connection.json');
  const saved = await readFile(stateFile, 'utf8');
  const opening = await f.request('/plugins/qq/desktop/open', {});
  assert.equal(opening.status, 200); assert.equal((await opening.json()).online, true);
  assert.equal((await f.request('/plugins/qq/desktop/open')).status, 404); // Host only dispatches POST for web.api.
  f.send(); await until(async () => (await f.status()).recent.some((n: any) => n.status === 'sent'));
  assert.equal((await f.save({ enabled: false })).status, 200);
  await until(() => f.socket().readyState === 3);
  assert.equal(f.generations.length, 1);
  assert.equal((await f.request('/plugins/qq/desktop/open', {})).status, 400);
  assert.equal((await f.save({ enabled: true })).status, 200); await f.online();
  await f.app.runtime.action('qq', 'stop'); await until(() => f.socket().readyState === 3);
  assert.equal(await f.app.runtime.services.get('witness')!.value.ping(), 'alive');
  await f.app.runtime.action('qq', 'start'); await f.online();
  f.send(); await until(async () => (await f.status()).recent.some((n: any) => n.status === 'sent'));
  assert.equal(f.generations.length, 1); assert.equal(f.calls.filter(c => c.action === 'send_private_msg').length, 1);
  assert.equal(await readFile(stateFile, 'utf8'), saved);
  const publicText = JSON.stringify(await (await f.request('/plugins/qq/config')).json());
  assert.ok(!publicText.includes('a'.repeat(64))); assert.ok(!publicText.includes('b'.repeat(64)));
  assert.ok(!f.calls.some(c => /login|logout/.test(c.action) && c.action !== 'get_login_info'));
});

test('desktop mode without QQ waits for the desktop and never starts independent login', async t => {
  const f = await fixture(t, { config: { connectionMode: 'desktop' } });
  await until(async () => ['connecting', 'disconnected'].includes((await f.status()).state));
  assert.equal(f.connects(), 0); assert.equal((await f.status()).engine, undefined);
  assert.equal((await f.request('/plugins/qq/refresh-qr', {})).status, 400);
  await f.app.runtime.action('qq', 'stop');
  assert.equal(await f.app.runtime.services.get('witness')!.value.ping(), 'alive');
});

test('desktop bridge preserves its connection across restarts, rejects corruption without resetting it', async () => {
  const root = await temporaryDirectory('whale-qq-desktop-config-');
  const controller = new AbortController();
  const config = parseConfig({ ...defaults, accountId: '100001' });
  const first = await new DesktopBridge(config, controller.signal, root).prepare();
  const next = await new DesktopBridge(config, controller.signal, root).prepare();
  assert.equal(first.wsUrl, next.wsUrl); assert.equal(first.accessToken, next.accessToken);
  assert.match(first.wsUrl, /^ws:\/\/127\.0\.0\.1:\d+\/$/); assert.equal(first.accessToken.length, 64);
  const file = join(root, 'data/desktop-bridge/connection.json');
  await writeFile(file, '{"version":99}');
  await assert.rejects(new DesktopBridge(config, controller.signal, root).prepare(), /原文件已保留/);
  assert.equal(await readFile(file, 'utf8'), '{"version":99}');
  controller.abort(); await assert.rejects(new DesktopBridge(config, controller.signal, root).prepare(), { name: 'AbortError' });
});

test('v2 upgrades keep the selected legacy mode and credentials; desktop requires an account', () => {
  assert.equal(parseConfig({ schemaVersion: 2 }).connectionMode, 'managed');
  for (const connectionMode of ['managed', 'external']) {
    const config = parseConfig({ schemaVersion: 2, connectionMode, wsUrl: 'ws://localhost:3001/', accessToken: 'keep-me' });
    assert.equal(config.schemaVersion, 3); assert.equal(config.connectionMode, connectionMode); assert.equal(config.accessToken, 'keep-me');
  }
  assert.throws(() => parseConfig({ enabled: true, connectionMode: 'desktop', personaId: 'a', allowedUsers: ['200002'] }), /机器人 QQ/);
});
