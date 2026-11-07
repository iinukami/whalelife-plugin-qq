import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fixture, until } from './fixture.ts';
import { segmentationDefaults } from '../src/config.ts';

const ack = '好，我先去看看。';
const tool = (name: string, args: unknown, id = name) => ({ id, name, arguments: JSON.stringify(args) });
const reply = (...calls: ReturnType<typeof tool>[]) => ({ text: '', toolCalls: calls });
const sends = (f: Awaited<ReturnType<typeof fixture>>) => f.calls.filter(c => c.action === 'send_private_msg');
const sent = (f: Awaited<ReturnType<typeof fixture>>, messageId = '1') => until(async () => (await f.status()).recent.some((n: any) => n.messageId === messageId && n.status === 'sent'));

test('current-turn acknowledgement arrives before slow work, deduplicates, pins the recipient and leaves final/ordinary replies intact', { timeout: 30000 }, async t => {
  let release = () => {}; t.after(() => release());
  const f = await fixture(t, { config: { permission: 'full', allowedUsers: ['200002', '300003'],
    segmentedReply: { ...segmentationDefaults, enabled: true, interval: '0,0' } } }); await f.online();
  const original = await f.app.sessions.current(), other = await f.app.sessions.create('other');
  let started = false, trusted: any, round = 0;
  t.after(f.app.tools.register({ name: 'slow_test_work', danger: 'safe', description: 'isolated slow work', schema: {},
    async run(_args: unknown, session: any) {
      started = true; trusted = session;
      await new Promise<void>((resolve, reject) => {
        const cancel = () => reject(Error('cancelled'));
        release = () => { session.signal.removeEventListener('abort', cancel); resolve(); };
        session.signal.addEventListener('abort', cancel, { once: true });
      });
      return { completed: true };
    } }));
  f.setGenerate(async input => {
    if (++round === 1) return reply(tool('qq_acknowledge', { text: ack }, 'ack1'), tool('qq_acknowledge', { text: ack }, 'ack2'),
      tool('qq_acknowledge', { text: '换句话重发' }, 'changed'), tool('slow_test_work', {}));
    const results = input.messages.filter((m: any) => m.role === 'tool').map((m: any) => JSON.parse(m.content).result);
    assert.equal(results[0].confirmed, true); assert.equal(results[0].taskCompleted, false);
    assert.equal(results[1].duplicate, true); assert.equal(results[2].confirmed, false);
    return { text: '处理完成。结果在这里。', toolCalls: [] };
  });
  f.send(); await until(() => started);
  assert.deepEqual(sends(f).map(c => c.params.message[0].data.text), [ack], 'ack was delivered while work is still pending');
  assert.equal(f.calls.filter(c => c.action === 'get_friend_list').length, 0, 'ack needs no extra contact request');
  for (const patch of [{ channel: 'web' }, { channel: 'plugin' }, { account: '999999' }, { peer: 'direct:300003' }, { sender: '300003' }, { id: other }]) {
    const result = await f.app.tools.call('qq_acknowledge', { text: ack }, { ...trusted, ...patch });
    assert.equal(result.result.status, 'blocked'); assert.equal(result.result.confirmed, false); assert.equal(result.result.delivery.outcome, 'not_sent');
  }
  for (const args of [{ text: '' }, { text: 'x'.repeat(81) }, { text: ack, userId: '300003' }, { text: ack, messageId: 'new' }, { text: ack, sessionId: other }])
    assert.equal((await f.app.tools.call('qq_acknowledge', args, trusted)).result.confirmed, false);
  assert.equal((await f.app.tools.call('qq_acknowledge', { text: ack }, { ...trusted, permission: 'off' })).ok, false);
  await f.request('/api/session/current', { id: other }); release(); await sent(f);
  assert.deepEqual(sends(f).map(c => c.params.message[0].data.text), [ack, '处理完成。', '结果在这里。']);
  assert.ok(sends(f).every(c => c.params.user_id === 200002));
  assert.equal((await f.app.memory.readSession(other)).length, 0);
  assert.ok((await f.app.memory.readSession(original)).some((r: any) => r.role === 'assistant' && r.text === '处理完成。结果在这里。'));
  assert.equal((await f.app.tools.call('qq_acknowledge', { text: ack }, trusted)).result.confirmed, false, 'finished turns cannot be acknowledged again');
  await f.app.runtime.action('qq', 'reload'); await f.online(); f.send(); await sent(f);
  assert.equal(sends(f).length, 3); assert.equal(round, 2);
  f.setGenerate(async () => ({ text: '普通聊天直接回复', toolCalls: [] })); f.send({ message_id: 2 }); await sent(f, '2');
  assert.equal(sends(f).length, 4); assert.equal(sends(f).at(-1).params.message[0].data.text, '普通聊天直接回复');
});

test('uncertain acknowledgement is not resent on repeat, changed content or inbound replay; final reply stays independent', async t => {
  const f = await fixture(t, { config: { permission: 'full' } }); await f.online(); let submitted = 0, round = 0;
  f.setAction((request, socket) => {
    if (request.action !== 'send_private_msg' || ++submitted !== 1) return false;
    socket.send(JSON.stringify({ echo: request.echo, status: 'async', retcode: 1, data: {} })); return true;
  });
  f.setGenerate(async input => {
    if (++round === 1) return reply(tool('qq_acknowledge', { text: ack }));
    if (round === 2) {
      assert.equal(JSON.parse(input.messages.at(-1).content).result.confirmed, false);
      return reply(tool('qq_acknowledge', { text: ack }, 'repeat'), tool('qq_acknowledge', { text: '换内容' }, 'changed'));
    }
    return { text: '操作尚未执行。', toolCalls: [] };
  });
  f.send(); await sent(f); assert.deepEqual(sends(f).map(c => c.params.message[0].data.text), [ack, '操作尚未执行。']);
  await f.app.runtime.action('qq', 'reload'); await f.online(); f.send(); await sent(f);
  assert.equal(sends(f).length, 2); assert.equal(round, 3);
});

test('stopping QQ cancels an in-flight acknowledgement and never replays it after restart', async t => {
  const f = await fixture(t, { config: { permission: 'full', requestTimeoutMs: 10000 } }); await f.online();
  f.setAction(request => request.action === 'send_private_msg');
  f.setGenerate(async () => reply(tool('qq_acknowledge', { text: ack })));
  f.send(); await until(() => sends(f).length === 1);
  const start = Date.now(); await f.app.runtime.action('qq', 'stop'); assert.ok(Date.now() - start < 3000);
  await f.app.runtime.action('qq', 'start'); await f.online(); f.send();
  await until(async () => (await f.status()).recent.length > 0);
  assert.equal(sends(f).length, 1); assert.equal(f.generations.length, 1);
  assert.equal(await f.app.runtime.services.get('witness')!.value.ping(), 'alive');
});

async function disk(root: string): Promise<string> {
  let value = '';
  try { for (const e of await readdir(root, { withFileTypes: true })) value += e.isDirectory() ? await disk(join(root, e.name)) : await readFile(join(root, e.name), 'utf8'); }
  catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
  return value;
}
test('acknowledgement in a transient turn preserves the existing no-private-body storage boundary', async t => {
  const secret = 'SYNTHETIC_ACK_PRIVATE_BODY';
  const f = await fixture(t, { config: { permission: 'full' } }); await f.online(); let round = 0;
  t.after(f.app.tools.registerTransient({ name: 'temporary_test_read', danger: 'safe', description: 'isolated read', schema: {}, run: () => ({ content: secret, receipt: null }) }));
  f.setGenerate(async () => ++round === 1 ? reply(tool('temporary_test_read', {}))
    : round === 2 ? reply(tool('qq_acknowledge', { text: secret })) : { text: '完成本轮处理。', toolCalls: [] });
  f.send(); await sent(f); assert.equal(sends(f)[0].params.message[0].data.text, secret);
  for (const folder of ['memory', 'logs', 'plugins/qq/data']) assert.ok(!(await disk(join(f.root, folder))).includes(secret), folder);
});
