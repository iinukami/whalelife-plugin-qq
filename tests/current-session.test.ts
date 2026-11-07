import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, mkdir, symlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { temporaryDirectory } from '../../whalelife/tests/temporary-directory.ts';
import { fixture, until } from './fixture.ts';
import { desktopConnection } from './desktop-fixture.ts';
import { segmentationDefaults } from '../src/config.ts';

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

test('current plugin runs unchanged on actual 213b52b host with legacy independent sessions', async t => {
  const root = await temporaryDirectory('whale-qq-legacy-host-');
  const host = new URL('../../whalelife', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
  const names = execFileSync('git', ['ls-tree', '-r', '--name-only', '213b52b', '--', 'core', 'package.json'], { cwd: host, encoding: 'utf8' }).trim().split('\n');
  for (const name of names) {
    const path = join(root, name); await mkdir(dirname(path), { recursive: true });
    await writeFile(path, execFileSync('git', ['show', '213b52b:' + name], { cwd: host }));
  }
  await symlink(join(host, 'node_modules'), join(root, 'node_modules'), 'junction');
  const { boot } = await import(pathToFileURL(join(root, 'core/index.ts')).href);
  const f = await fixture(t, { hostBoot: boot, config: { mediaHosts: ['qq.com', 'qpic.cn', 'gtimg.cn', 'gtimg.com'] } }); await f.online();
  assert.ok((await f.configFile()).mediaHosts.includes('multimedia.nt.qq.com.cn'));
  assert.deepEqual(await f.app.memory.listSessionMeta(), {});
  f.send(); await sent(f, '1');
  const id = Object.keys(await f.app.memory.listSessionMeta())[0]; assert.match(id, /^ch_/);
  await f.app.runtime.action('qq', 'reload'); await f.online(); f.send(); await sent(f, '1');
  assert.equal(f.generations.length, 1);
  assert.equal(await f.app.runtime.services.get('witness')!.value.ping(), 'alive');
  await f.save({ permission: 'full' }); await f.online();
  const modelSend = await f.app.tools.call('qq_send_message',
    { userId: '200002', messageId: 'legacy-tool', text: '旧宿主模型工具发送' }, { id, permission: 'full' });
  assert.equal(modelSend.result.status, 'sent'); assert.equal(modelSend.result.sessionId, id);
  assert.equal((await f.app.tools.call('qq_send_message',
    { userId: '200002', messageId: 'legacy-tool', text: '旧宿主模型工具发送' }, { id, permission: 'full' })).result.duplicate, true);
  let ackRound = 0;
  f.setGenerate(async () => ++ackRound === 1 ? { text: '', toolCalls: [{ id: 'legacy-ack', name: 'qq_acknowledge', arguments: JSON.stringify({ text: '旧宿主先接话。' }) }] }
    : { text: '旧宿主处理完成。', toolCalls: [] });
  f.send({ message_id: 2 }); await sent(f, '2');
  assert.deepEqual(f.calls.filter(c => c.action === 'send_private_msg').slice(-2).map(c => c.params.message[0].data.text), ['旧宿主先接话。', '旧宿主处理完成。']);
  const desktop = await fixture(t, { hostBoot: boot, config: { connectionMode: 'desktop' }, preparePlugin: desktopConnection });
  await desktop.online(); desktop.send(); await sent(desktop, '1');
  await desktop.app.runtime.action('qq', 'stop'); await until(() => desktop.socket().readyState === 3);
  await desktop.app.runtime.action('qq', 'start'); await desktop.online(); desktop.send(); await sent(desktop, '1');
  assert.equal(desktop.generations.length, 1);
  await desktop.save({ segmentedReply: { ...segmentationDefaults, enabled: true, interval: '0,0' } }); await desktop.online();
  desktop.setGenerate(async () => ({ text: '旧主干。也分段！', toolCalls: [] }));
  desktop.send({ message_id: 2 }); await sent(desktop, '2');
  assert.deepEqual(desktop.calls.filter(c => c.action === 'send_private_msg').slice(-2).map(c => c.params.message[0].data.text), ['旧主干。', '也分段！']);
  desktop.setAction((data, socket) => {
    if (data.action !== 'send_private_msg') return false;
    socket.send(JSON.stringify({ echo: data.echo, status: 'failed', retcode: 1200, data: {} })); return true;
  });
  desktop.send({ message_id: 3 }); await until(async () => (await desktop.status()).recent.some((n: any) => n.messageId === '3' && n.status === 'delivery_failed'));
  const legacyId = Object.keys(await desktop.app.memory.listSessionMeta())[0];
  assert.ok((await desktop.app.memoryEngine.state(legacyId)).records.some((r: any) => r.source === 'qq' && /自动回复投递结果.*结果未知/.test(r.text)));
  assert.equal(modelSend.result.delivery.outcome, 'sent');
  const service = f.app.runtime.services.get('qq')!.value;
  assert.equal(service.qzoneReferenceApiVersion, '1.0.0');
  assert.equal(service.qzoneVideoApiVersion, '1.0.0');
  await assert.rejects(service.qzoneReadVideo({ sessionId: id, ref: 'invalid', index: 0 }, { signal: new AbortController().signal }), /动态引用/);
  assert.equal((await service.qzoneReferenceStatus({ sessionId: id, ref: 'invalid' }, { signal: new AbortController().signal })).reason, 'invalid_reference');
});
