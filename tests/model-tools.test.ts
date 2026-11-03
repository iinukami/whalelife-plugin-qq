import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fixture, until } from './fixture.ts';
import { segmentationDefaults } from '../src/config.ts';

type Fixture = Awaited<ReturnType<typeof fixture>>;
const sends = (f: Fixture) => f.calls.filter(c => c.action === 'send_private_msg');
const tool = (name: string, args: unknown) => ({ text: '', toolCalls: [{ id: name + '-call', name, arguments: JSON.stringify(args) }] });
async function caller(f: Fixture) {
  const dir = join(f.root, 'plugins/wake-probe'); await mkdir(dir);
  await writeFile(join(dir, 'plugin.yaml'), 'id: wake-probe\nname: Probe\nversion: 1.0.0\ndescription: Isolated caller\n');
  await writeFile(join(dir, 'index.ts'), `export function apply(ctx) {
    let controller;
    ctx.provide('wake-probe', {
      async run(input) { controller = new AbortController(); try {
        return await ctx.sessions.runTransient({ ...input, permission: 'full', signal: controller.signal });
      } finally { controller = undefined; } },
      normal: input => ctx.sessions.run({ ...input, permission: 'full' }),
      cancel: () => controller?.abort(Error('test-cancel')),
    });
  }`);
  await f.app.runtime.loadPath('wake-probe');
  return f.app.runtime.services.get('wake-probe')!.value;
}
function call(f: Fixture, sessionId: string, args: unknown, signal?: AbortSignal, permission = 'full') {
  return f.app.tools.call('qq_send_message', args, { id: sessionId, permission, signal });
}

for (const existing of [false, true]) test(`transient model sees contacts and sends under its session lock (${existing ? 'existing' : 'first'} binding)`, { timeout: 20000 }, async t => {
  const f = await fixture(t, { config: { permission: 'full', allowedUsers: ['200002', '300003'],
    segmentedReply: { ...segmentationDefaults, enabled: true, interval: '0,0', maxLength: 32000 } } });
  await f.online(); const id = await f.app.sessions.current(), runner = await caller(f);
  if (existing) await f.app.runtime.services.get('qq')!.value.sendText({ userId: '200002', messageId: 'setup', text: 'setup' });
  const before = sends(f).length; let turn = 0;
  f.setAction((request, socket) => {
    if (request.action !== 'get_friend_list') return false;
    socket.send(JSON.stringify({ echo: request.echo, status: 'ok', retcode: 0, data: [
      { user_id: 200002, nickname: '甲', remark: '明确约定的联系人' },
      { user_id: 300003, nickname: '乙' }, { user_id: 999999, nickname: '不在白名单' },
    ] })); return true;
  });
  const args = { userId: '200002', messageId: 'agreement-001', text: '第一句。第二句！' };
  f.setGenerate(async input => {
    assert.ok(f.app.sessions.locks.has(id));
    assert.ok(input.tools.some((x: any) => x.function.name === 'qq_send_message'));
    if (turn++ === 0) return tool('qq_list_recipients', {});
    const reply = JSON.parse(input.messages.at(-1).content).result;
    if (turn === 2) {
      assert.equal(reply.currentRecipient, null, 'transient peer is a session ID, not a QQ recipient');
      assert.deepEqual(reply.recipients.map((r: any) => r.userId), ['200002', '300003']);
      assert.equal(reply.recipients[0].remark, '明确约定的联系人');
      return tool('qq_send_message', args);
    }
    assert.equal(reply.status, 'sent'); assert.equal(reply.confirmed, true); assert.equal(reply.sessionId, id);
    return { text: '已核对送达。', toolCalls: [] };
  });
  await runner.run({ sessionId: id, text: 'synthetic-transient-wakeup' });
  assert.deepEqual(sends(f).slice(before).map(c => c.params.message[0].data.text), ['第一句。', '第二句！']);
  assert.ok(sends(f).every(c => String(c.params.user_id) === '200002'));
  const rows = await f.app.memory.readSession(id);
  assert.ok(rows.some((r: any) => r.type === 'channel_receipt' && r.status === 'sent' && r.direction === 'out'));
  assert.ok(!JSON.stringify(rows).includes('synthetic-transient-wakeup'));
  const duplicate = await call(f, id, args); assert.equal(duplicate.result.duplicate, true);
  assert.equal(sends(f).length, before + 2);
  await f.app.runtime.action('qq', 'reload'); await f.online();
  assert.equal((await call(f, id, args)).result.duplicate, true);
  assert.equal(sends(f).length, before + 2);
});

test('idle binding follows Web selection before a transient model sends in the new session', async t => {
  const f = await fixture(t, { config: { permission: 'full' } }); await f.online();
  const a = await f.app.sessions.current(), runner = await caller(f);
  await until(async () => (await f.status()).binding?.sessionId === a && (await f.status()).binding?.state === 'ready');
  assert.equal(sends(f).length, 0, 'preparing a binding sends nothing');
  const b = await f.app.sessions.create('Next'); await f.request('/api/session/current', { id: b });
  await until(async () => (await f.status()).binding?.sessionId === b && (await f.status()).binding?.state === 'ready');
  const args = { userId: '200002', messageId: 'after-selection', text: 'new-session-message' }; let turn = 0;
  f.setGenerate(async input => {
    assert.ok(f.app.sessions.locks.has(b));
    if (turn++ === 0) return tool('qq_send_message', args);
    const reply = JSON.parse(input.messages.at(-1).content).result;
    assert.equal(reply.status, 'sent'); assert.equal(reply.confirmed, true); assert.equal(reply.sessionId, b);
    return { text: 'done', toolCalls: [] };
  });
  await runner.run({ sessionId: b, text: 'test' });
  assert.equal(sends(f).length, 1);
  assert.equal((await f.app.memory.readSession(a)).length, 0);
  await call(f, b, args); assert.equal(sends(f).length, 1);
});

test('binding conflict blocks repeated attempts until real idle recovery, without replaying messages', { timeout: 15000 }, async t => {
  let release!: () => void, reached!: () => void;
  const gate = new Promise<void>(resolve => release = resolve), held = new Promise<void>(resolve => reached = resolve);
  t.after(release);
  const f = await fixture(t, { config: { permission: 'full' } }); await f.online();
  const a = await f.app.sessions.current(), runner = await caller(f);
  await f.app.runtime.services.get('qq')!.value.sendText({ userId: '200002', messageId: 'setup', text: 'setup' });
  // Deterministically prevent the idle watcher from winning this race before B starts.
  f.app.sessions.locks.add(a); t.after(() => f.app.sessions.locks.delete(a));
  const b = await f.app.sessions.create('Next'); await f.request('/api/session/current', { id: b });
  const args = { userId: '200002', messageId: 'rebind', text: 'new-session-message' }; let turn = 0;
  f.setGenerate(async input => {
    if (turn++ === 0) return tool('qq_send_message', args);
    const reply = JSON.parse(input.messages.at(-1).content).result;
    assert.equal(reply.status, 'blocked'); assert.match(reply.error, /会话切换未完成/);
    if (turn === 2) return tool('qq_send_message', args);
    assert.equal(reply.repeatBlocked, true, 'second attempt is stopped by code, not by model cooperation');
    if (turn === 3) return tool('qq_send_message', { ...args, messageId: 'changed-id' });
    reached(); await gate;
    return { text: '尚未发送。', toolCalls: [] };
  });
  const running = runner.run({ sessionId: b, text: 'test' });
  await Promise.race([held, running]); f.app.sessions.locks.delete(a);
  await new Promise(r => setTimeout(r, 1200));
  assert.equal((await f.status()).binding.state, 'waiting', 'B is still running');
  assert.equal((await call(f, b, args)).result.repeatBlocked, true, 'polling time does not clear the gate');
  release(); await running;
  await until(async () => (await f.status()).binding?.sessionId === b && (await f.status()).binding?.state === 'ready');
  assert.equal(sends(f).length, 1, 'recovery never replays any blocked request');
  assert.equal((await call(f, b, args)).result.status, 'sent');
  assert.equal(sends(f).length, 2);
  assert.equal((await call(f, b, args)).result.duplicate, true); assert.equal(sends(f).length, 2);
  assert.ok(!(await f.app.memory.readSession(a)).some((r: any) => r.text === args.text));
});

test('idle binding watcher stops with the plugin and resumes without sending on restart', async t => {
  const f = await fixture(t); await f.online();
  const a = await f.app.sessions.current();
  await until(async () => (await f.status()).binding?.sessionId === a && (await f.status()).binding?.state === 'ready');
  await f.app.runtime.action('qq', 'stop');
  const b = await f.app.sessions.create('After stop'); await f.request('/api/session/current', { id: b });
  await new Promise(r => setTimeout(r, 1200));
  const routes = Object.values<any>(JSON.parse(await readFile(join(f.root, 'memory/index.json'), 'utf8')).channel_routes ?? {});
  assert.equal(routes.length, 1); assert.equal(routes[0].sessionId, a);
  await f.app.runtime.action('qq', 'start'); await f.online();
  await until(async () => (await f.status()).binding?.sessionId === b && (await f.status()).binding?.state === 'ready');
  assert.equal(sends(f).length, 0); assert.equal(f.generations.length, 0);
});

test('ordinary model tool pins calling session across Web selection changes; inbound replies still work', async t => {
  const f = await fixture(t, { config: { permission: 'full' } }); await f.online();
  const a = await f.app.sessions.current(), b = await f.app.sessions.create('Other'), runner = await caller(f); let turn = 0;
  f.setGenerate(async input => {
    if (turn++ === 0) {
      await f.request('/api/session/current', { id: b });
      return tool('qq_send_message', { userId: '200002', messageId: 'ordinary', text: 'pinned-to-A' });
    }
    assert.equal(JSON.parse(input.messages.at(-1).content).result.sessionId, a);
    return { text: 'done', toolCalls: [] };
  });
  await runner.normal({ sessionId: a, text: 'test' });
  assert.equal((await f.app.memory.readSession(b)).length, 0);
  f.setGenerate(undefined); f.send();
  await until(async () => (await f.status()).recent.some((x: any) => x.status === 'sent'));
  assert.equal(sends(f).length, 2);
});

test('tools enforce permission, whitelist, explicit target and consistent dedup content without faulting QQ', async t => {
  const f = await fixture(t, { config: { permission: 'full' } }); await f.online(); const id = await f.app.sessions.current();
  const args = { userId: '200002', messageId: 'allowed', text: 'allowed' };
  for (const permission of ['off', 'ask']) assert.equal((await call(f, id, args, undefined, permission)).ok, false);
  for (const bad of [{ ...args, userId: '999999' }, { ...args, userId: '主人' }, { ...args, userId: '100001' },
    { ...args, text: '' }, { ...args, sessionId: 'forged' }, { ...args, messageId: '' }]) {
    assert.equal((await call(f, id, bad)).result.status, 'blocked');
  }
  assert.equal(sends(f).length, 0);
  assert.equal((await call(f, id, args)).result.status, 'sent');
  assert.equal((await call(f, id, { ...args, text: 'changed' })).result.status, 'blocked');
  assert.equal(sends(f).length, 1);
  await f.save({ permission: 'off' }); await f.online();
  assert.equal((await call(f, id, { ...args, messageId: 'off' })).result.status, 'blocked');
  assert.equal(f.app.runtime.records.get('qq')?.status, 'active');
});

test('contact lookup failure returns only configured IDs and never interprets a non-QQ peer', async t => {
  const f = await fixture(t, { config: { permission: 'full' } }); await f.online();
  f.setAction((request, socket) => {
    if (request.action !== 'get_friend_list') return false;
    socket.send(JSON.stringify({ echo: request.echo, status: 'failed', retcode: 1 })); return true;
  });
  const id = await f.app.sessions.current();
  const result = await f.app.tools.call('qq_list_recipients', {}, { id, permission: 'full', channel: 'plugin', account: 'autonomy', peer: 'direct:200002' });
  assert.equal(result.result.currentRecipient, null); assert.equal(result.result.contactsAvailable, false);
  assert.deepEqual(result.result.recipients.map((r: any) => r.userId), ['200002']);
  const qq = await f.app.tools.call('qq_list_recipients', {}, { id, permission: 'full', channel: 'qq', account: '100001', peer: 'direct:200002' });
  assert.equal(qq.result.currentRecipient, '200002'); assert.equal(sends(f).length, 0);
});

for (const mode of ['failed', 'async', 'missing-id']) test(`platform ${mode} cannot become sent or trigger duplicate model delivery`, async t => {
  const f = await fixture(t, { config: { permission: 'full' } }); await f.online(); const id = await f.app.sessions.current();
  f.setAction((request, socket) => {
    if (request.action !== 'send_private_msg') return false;
    socket.send(JSON.stringify({ echo: request.echo, status: mode === 'missing-id' ? 'ok' : mode, retcode: mode === 'missing-id' ? 0 : 1, data: {} })); return true;
  });
  const args = { userId: '200002', messageId: mode, text: 'test' };
  const first = await call(f, id, args); assert.equal(first.result.confirmed, false); assert.notEqual(first.result.status, 'sent');
  const repeated = await call(f, id, args); assert.equal(sends(f).length, 1);
  assert.equal(repeated.result.delivery.outcome, 'unknown'); assert.equal(repeated.result.delivery.unknownParts, 1);
  assert.equal(await f.app.runtime.services.get('witness')!.value.ping(), 'alive');
});

test('transient caller cancellation reaches pending QQ send and does not resend on repeat', { timeout: 15000 }, async t => {
  const f = await fixture(t, { config: { permission: 'full', requestTimeoutMs: 10000 } }); await f.online();
  const id = await f.app.sessions.current(), runner = await caller(f), args = { userId: '200002', messageId: 'cancel', text: 'test' };
  f.setAction(request => request.action === 'send_private_msg');
  f.setGenerate(async () => tool('qq_send_message', args));
  const running = runner.run({ sessionId: id, text: 'cancel-test' }).catch((e: Error) => e);
  await until(() => sends(f).length === 1); const start = Date.now(); await runner.cancel();
  await running; assert.ok(Date.now() - start < 3000, 'tool cancellation does not wait for 10s platform timeout');
  await call(f, id, args); assert.equal(sends(f).length, 1);
  assert.equal(f.app.runtime.records.get('qq')?.status, 'active');
});

test('stop cancels segmented tool wait, removes tools, and retains receipts on reload', async t => {
  const f = await fixture(t, { config: { permission: 'full', segmentedReply: { ...segmentationDefaults, enabled: true, interval: '0.5,0.5' } } });
  await f.online(); const id = await f.app.sessions.current(), args = { userId: '200002', messageId: 'stop', text: '第一句。第二句。第三句。' };
  const pending = call(f, id, args); await until(() => sends(f).length === 1);
  await f.app.runtime.action('qq', 'stop'); await pending;
  assert.equal(sends(f).length, 1); assert.ok(!f.app.tools.list().some((x: any) => x.function.name.startsWith('qq_')));
  await f.app.runtime.action('qq', 'start'); await f.online();
  const repeated = await call(f, id, args); assert.equal(sends(f).length, 1);
  assert.equal(repeated.result.delivery.outcome, 'partial'); assert.equal(repeated.result.delivery.sentParts, 1);
  assert.equal(repeated.result.delivery.unknownParts, 0);
  assert.equal(await f.app.runtime.services.get('witness')!.value.ping(), 'alive');
});
