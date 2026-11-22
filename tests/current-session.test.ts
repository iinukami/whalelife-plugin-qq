import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, symlink, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { temporaryDirectory } from '../../whalelife/tests/temporary-directory.ts';
import { fixture, until } from './fixture.ts';

const sent = (f: Awaited<ReturnType<typeof fixture>>, id: string) => until(async () =>
  (await f.status()).recent.some((n: any) => n.messageId === id && n.status === 'sent'));

test('QQ reuses Web history, follows selection and keeps deduplication across reload', async t => {
  const f = await fixture(t); await f.online();
  await new Promise(r => setTimeout(r, 1200));
  assert.deepEqual(await f.app.memory.listSessionMeta(), {}, 'login does not create a session');
  const a = await f.app.sessions.create('Web A'), b = await f.app.sessions.create('Web B');
  await f.app.memory.appendEvent({ session: a, type: 'message', role: 'user', text: 'web-history-marker' });
  assert.equal((await f.request('/api/session/current', { id: a })).status, 200);
  f.send(); await sent(f, '1');
  assert.ok(JSON.stringify(f.generations[0].messages).includes('web-history-marker'));
  assert.ok((await f.app.memory.readSession(a)).some((r: any) => r.text === '你好🙂'));
  await f.request('/api/session/current', { id: b });
  f.send({ message_id: 2 }); await sent(f, '2');
  assert.ok(!JSON.stringify(f.generations[1].messages).includes('web-history-marker'));
  assert.ok((await f.app.memory.readSession(b)).some((r: any) => r.text === '你好🙂'));
  await f.app.runtime.action('qq', 'reload'); await f.online();
  f.send(); await sent(f, '1');
  assert.equal(f.generations.length, 2);
  assert.equal(f.calls.filter(c => c.action === 'send_private_msg').length, 2);
  assert.deepEqual(Object.keys(await f.app.memory.listSessionMeta()).sort(), [a,b].sort());
});

test('empty host creates one current session; deleted binding recovers after plugin reload', async t => {
  const f = await fixture(t); await f.online();
  f.send(); await sent(f, '1');
  const a = await f.app.sessions.current();
  assert.deepEqual(Object.keys(await f.app.memory.listSessionMeta()), [a]);
  await f.app.memoryAdmin.deleteSession({ id: a });
  await f.app.runtime.action('qq', 'reload'); await f.online();
  f.send({ message_id: 2 }); await sent(f, '2');
  const b = await f.app.sessions.current(); assert.notEqual(a, b);
  assert.ok((await f.app.memory.readSession(b)).some((r: any) => r.text === '你好🙂'));
  assert.equal(Object.values<any>(await f.app.memory.listSessionMeta()).filter(m => !m.deleted).length, 1);
});

test('a target deleted before first binding fails without creating a separate QQ session', async t => {
  const f = await fixture(t); await f.online();
  const current = f.app.sessions.current.bind(f.app.sessions);
  f.app.sessions.current = async (...args: Parameters<typeof current>) => {
    const id = await current(...args); await f.app.memoryAdmin.deleteSession({ id }); return id;
  };
  f.send(); await until(async () => (await f.status()).recent.some((n: any) => n.status === 'failed'));
  assert.equal(f.generations.length, 0);
  assert.equal(f.calls.filter(c => c.action === 'send_private_msg').length, 0);
  const entries = Object.entries<any>(await f.app.memory.listSessionMeta());
  assert.equal(entries.length, 1); assert.equal(entries[0][1].deleted, true);
  assert.ok(!entries[0][0].startsWith('ch_'));
});

test('existing independent route migrates through public APIs without replaying old receipts', async t => {
  const f = await fixture(t, { config: { enabled: false } });
  const legacy = f.app.channels.register({ id: 'qq', account: '100001', persona: 'a', permission: 'off', send: async () => {} }, 'qq');
  await legacy.receive({ peer: 'direct:200002', sender: '200002', messageId: '1', text: '你好🙂' });
  legacy.dispose();
  const old = Object.keys(await f.app.memory.listSessionMeta())[0]; assert.match(old, /^ch_/);
  const web = await f.app.sessions.create('Existing Web');
  await f.request('/api/session/current', { id: web });
  assert.equal((await f.save({ enabled: true })).status, 200); await f.online();
  f.send({ message_id: 2 }); await sent(f, '2');
  assert.ok((await f.app.memory.readSession(old)).some((r: any) => r.text === '你好🙂'));
  assert.ok((await f.app.memory.readSession(web)).some((r: any) => r.text === '你好🙂'));
  f.send(); await until(async () => (await f.status()).recent[0]?.messageId === '1');
  assert.equal(f.generations.length, 2);
  assert.equal(f.calls.filter(c => c.action === 'send_private_msg').length, 1);
});

test('Web switch during a reply leaves that reply in place; next message and direct send follow Web', async t => {
  const f = await fixture(t); await f.online();
  const a = await f.app.sessions.current(), b = await f.app.sessions.create('Next');
  let release!: () => void;
  f.setGenerate(() => new Promise(r => { release = () => r({ text: 'reply-for-A', toolCalls: [] }); }));
  f.send(); await until(() => !!release);
  await f.request('/api/session/current', { id: b });
  await assert.rejects(f.app.runtime.services.get('qq')!.value.sendText({ userId: '200002', messageId: 'busy', text: 'not sent' }));
  assert.equal(f.calls.filter(c => c.action === 'send_private_msg').length, 0);
  release(); await sent(f, '1');
  assert.ok((await f.app.memory.readSession(a)).some((r: any) => r.text === 'reply-for-A'));
  assert.equal((await f.app.memory.readSession(b)).length, 0);
  f.setGenerate(undefined); f.send({ message_id: 2 }); await sent(f, '2');
  await f.app.runtime.services.get('qq')!.value.sendText({ userId: '200002', messageId: 'direct', text: 'direct-to-B' });
  assert.ok((await f.app.memory.readSession(b)).some((r: any) => r.type === 'channel_receipt' && r.external_message_id === 'direct'));
  assert.equal(f.generations.length, 2);
});

test('a host predating active channel personas blocks QQ before connecting even with a legacy fixed persona', async t => {
  const root = await temporaryDirectory('whale-qq-legacy-host-');
  const host = fileURLToPath(new URL('../../whalelife', import.meta.url));
  const git = ['-c', 'safe.directory=' + host.replaceAll('\\', '/'), '-C', host];
  const commit = execFileSync('git', [...git, 'rev-parse', 'refs/tags/213b52b^{commit}'], { encoding: 'utf8' }).trim();
  assert.equal(commit, '7c8e3898b2bc7cb0b892eb0ab2feec0ca9c8aaf0');
  const archive = join(root, 'host.tar');
  execFileSync('git', [...git, 'archive', '--format=tar', '--output=' + archive, commit, 'core', 'package.json']);
  execFileSync('tar', ['-xf', archive, '-C', root]);
  const deps = join(root, 'node_modules');
  await symlink(join(host, 'node_modules'), deps, 'junction');
  t.after(() => unlink(deps));
  const { boot } = await import(pathToFileURL(join(root, 'core/index.ts')).href);
  const f = await fixture(t, { hostBoot: boot, includeQzone: false, preparePlugin: async dir => {
    const file = join(dir, 'data', 'config.json');
    const config = JSON.parse(await readFile(file, 'utf8'));
    await writeFile(file, JSON.stringify({ ...config, personaId: 'b' }));
  } });
  const state = await f.status();
  assert.notEqual(state.state, 'online');
  assert.match(state.error, /升级/);
  assert.doesNotMatch(state.error, /选择固定人格/);
  const settings = await (await f.request('/plugins/qq/config')).json();
  assert.equal(Object.hasOwn(settings.config, 'personaId'), false);
  assert.equal((await f.save({ enabled: true })).status, 400);
  assert.equal((await f.save({ enabled: true, personaId: 'a' })).status, 400);
  assert.equal(f.generations.length, 0);
  assert.equal(f.connects(), 0);
  assert.deepEqual(await f.app.memory.listSessionMeta(), {});
  assert.equal(await f.app.runtime.services.get('witness')!.value.ping(), 'alive');
});
