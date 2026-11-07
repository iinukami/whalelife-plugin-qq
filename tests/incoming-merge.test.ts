import { test } from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { createHash } from 'node:crypto';
import { fixture, until } from './fixture.ts';
import { segmentationDefaults } from '../src/config.ts';

type Fixture = Awaited<ReturnType<typeof fixture>>;
const message = (f: Fixture, id: number, text: string, user = 200002) => f.send({ message_id: id, user_id: user, message: [{ type: 'text', data: { text } }] });
const sends = (f: Fixture) => f.calls.filter(c => c.action === 'send_private_msg');
const texts = (f: Fixture) => sends(f).map(c => c.params.message[0].data.text);
const noticed = (f: Fixture, id: number, status: string) => until(async () => (await f.status()).recent.some((n: any) => n.messageId === String(id) && n.status === status));
const reply = (text: string) => ({ text, toolCalls: [] });
const call = (name: string, args = {}) => ({ id: name, name, arguments: JSON.stringify(args) });
function gate() {
  let release!: () => void;
  const waiting = new Promise<void>(r => { release = r; });
  return { release, async wait(signal: AbortSignal) {
    await new Promise<void>((resolve, reject) => {
      const cancel = () => reject(Error('cancelled'));
      signal.addEventListener('abort', cancel, { once: true });
      void waiting.then(() => { signal.removeEventListener('abort', cancel); resolve(); });
      if (signal.aborted) cancel();
    });
  } };
}

test('supplements during model generation share one segmented final, individual history and deduplicated receipts', async t => {
  const held = gate(); t.after(held.release);
  const f = await fixture(t, { config: { segmentedReply: { ...segmentationDefaults, enabled: true, interval: '0,0' } } }); await f.online();
  let rounds = 0;
  f.setGenerate(async input => {
    if (++rounds === 1) { await held.wait(input.signal); return reply('STALE_UNSENT_ANSWER'); }
    for (const text of ['FIRST_INPUT', 'LATER_INPUT', 'LAST_INPUT']) assert.ok(JSON.stringify(input.messages).includes(text));
    return reply('合并完成。只回一次。');
  });
  message(f, 101, 'FIRST_INPUT'); await until(() => rounds === 1);
  message(f, 102, 'LATER_INPUT'); message(f, 103, 'LAST_INPUT'); message(f, 103, 'LAST_INPUT');
  await noticed(f, 103, 'merged'); assert.equal(sends(f).length, 0); held.release();
  await noticed(f, 103, 'sent'); await until(async () => (await f.status()).queued === 0);
  assert.equal(rounds, 2); assert.deepEqual(texts(f), ['合并完成。', '只回一次。']);
  const rows = await f.app.memory.readSession(await f.app.sessions.current());
  assert.deepEqual(rows.filter((r: any) => r.role === 'user').map((r: any) => r.external_message_id), ['101', '102', '103']);
  assert.equal(rows.filter((r: any) => r.role === 'assistant').length, 1);
  assert.ok(!JSON.stringify(rows).includes('STALE_UNSENT_ANSWER'));
  await f.app.runtime.action('qq', 'reload'); await f.online();
  message(f, 102, 'LATER_INPUT'); await noticed(f, 102, 'sent');
  assert.equal(rounds, 2); assert.equal(sends(f).length, 2);
});

test('simultaneous first arrivals serialize opening and keep every message in order', async t => {
  const held = gate(); t.after(held.release);
  const f = await fixture(t); await f.online(); let rounds = 0;
  f.setGenerate(async input => { if (++rounds === 1) await held.wait(input.signal); return reply('ALL_INPUTS'); });
  for (let i = 1; i <= 5; i++) message(f, i, `INPUT_${i}`);
  await noticed(f, 5, 'merged'); held.release(); await noticed(f, 5, 'sent');
  assert.equal(sends(f).length, 1);
  const rows = await f.app.memory.readSession(await f.app.sessions.current());
  assert.deepEqual(rows.filter((r: any) => r.role === 'user').map((r: any) => r.external_message_id), ['1', '2', '3', '4', '5']);
});

test('acknowledgement keeps input open; tool-time correction preserves completed work and suppresses remaining old calls', async t => {
  const held = gate(); t.after(held.release);
  const f = await fixture(t, { config: { permission: 'full' } }); await f.online();
  let rounds = 0, work = 0, staleActions = 0;
  t.after(f.app.tools.register({ name: 'slow_merge_test', description: 'synthetic work', danger: 'safe', schema: {},
    async run(_args: unknown, session: any) { work++; await held.wait(session.signal); return { value: 'PRESERVED_RESULT' }; } }));
  t.after(f.app.tools.register({ name: 'stale_action_test', description: 'must be reconsidered', danger: 'safe', schema: {},
    async run() { staleActions++; return {}; } }));
  f.setGenerate(async input => {
    if (++rounds === 1) return { text: '', toolCalls: [call('qq_acknowledge', { text: '我先看看。' }), call('slow_merge_test'), call('stale_action_test')] };
    const context = JSON.stringify(input.messages);
    assert.ok(context.includes('PRESERVED_RESULT')); assert.ok(context.includes('ONLY_LATEST'));
    return reply('按补充处理好了。');
  });
  message(f, 1, 'READ_POST'); await until(() => work === 1);
  assert.deepEqual(texts(f), ['我先看看。']);
  message(f, 2, 'ONLY_LATEST'); await noticed(f, 2, 'merged'); held.release(); await noticed(f, 2, 'sent');
  assert.equal(work, 1); assert.equal(staleActions, 0); assert.deepEqual(texts(f), ['我先看看。', '按补充处理好了。']);
});

test('new input while final delivery is pending opens the next turn without duplicating segments', async t => {
  const f = await fixture(t, { config: { requestTimeoutMs: 10000, segmentedReply: { ...segmentationDefaults, enabled: true, interval: '0,0' } } }); await f.online();
  let delivery: any, rounds = 0;
  f.setAction((request, socket) => {
    if (request.action !== 'send_private_msg' || delivery) return false;
    delivery = { request, socket }; return true;
  });
  f.setGenerate(async () => reply(++rounds === 1 ? '第一轮。两段。' : '第二轮。'));
  message(f, 1, 'FIRST'); await until(() => delivery);
  const nextSession = await f.app.sessions.create('next-current');
  await f.request('/api/session/current', { id: nextSession });
  message(f, 2, 'AFTER_FINAL_STARTED'); await noticed(f, 2, 'next_turn');
  assert.equal(rounds, 1);
  delivery.socket.send(JSON.stringify({ status: 'ok', retcode: 0, data: { message_id: 12345 }, echo: delivery.request.echo }));
  await noticed(f, 2, 'sent'); assert.equal(rounds, 2); assert.deepEqual(texts(f), ['第一轮。', '两段。', '第二轮。']);
  assert.ok((await f.app.memory.readSession(nextSession)).some((row: any) => row.role === 'user' && row.text.includes('AFTER_FINAL_STARTED')));
});

test('formal image delivery seals input after validation and leaves following input for a new turn', async t => {
  const held = gate(); t.after(held.release);
  const f = await fixture(t, { config: { permission: 'full' } }); await f.online(); let rounds = 0;
  const png = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#ff9900' } }).png().toBuffer();
  const image = { type: 'image', id: createHash('sha256').update(png).digest('hex'), mime: 'image/png', base64: png.toString('base64'), asMeme: true };
  t.after(f.app.tools.register({ name: 'send_synthetic_image', description: 'isolated image delivery', danger: 'safe', schema: {},
    async run(_args: unknown, session: any) {
      return f.app.runtime.services.get('qq')!.value.sendMedia({ userId: '200002', actionId: 'synthetic-image', sessionId: session.id, parts: [image] }, { signal: session.signal });
    } }));
  f.setGenerate(async input => {
    if (++rounds === 1) return { text: '', toolCalls: [call('send_synthetic_image')] };
    if (rounds === 2) { await held.wait(input.signal); return reply('第一轮结束'); }
    return reply('图片之后的新一轮');
  });
  message(f, 1, 'SEND_IMAGE'); await until(() => rounds === 2);
  assert.equal(sends(f)[0].params.message[0].type, 'image');
  message(f, 2, 'AFTER_IMAGE'); await noticed(f, 2, 'next_turn'); held.release(); await noticed(f, 2, 'sent');
  assert.equal(rounds, 3); assert.equal(sends(f).filter(c => c.params.message[0].type === 'image').length, 1);
});

test('formal text tool closes input while early acknowledgement does not', async t => {
  const held = gate(); t.after(held.release);
  const f = await fixture(t, { config: { permission: 'full' } }); await f.online(); let rounds = 0;
  f.setGenerate(async input => {
    if (++rounds === 1) return { text: '', toolCalls: [call('qq_send_message', { userId: '200002', messageId: 'formal-result', text: '正式结果' })] };
    if (rounds === 2) { await held.wait(input.signal); return reply('第一轮结束'); }
    return reply('第二轮结果');
  });
  message(f, 1, 'START'); await until(() => rounds === 2); assert.deepEqual(texts(f), ['正式结果']);
  message(f, 2, 'NEW_TURN'); await noticed(f, 2, 'next_turn'); held.release(); await noticed(f, 2, 'sent');
  assert.equal(rounds, 3); assert.deepEqual(texts(f), ['正式结果', '第一轮结束', '第二轮结果']);
});

test('image, voice and emoji normalization can join a pending turn without losing media input', async t => {
  const held = gate(); t.after(held.release);
  const f = await fixture(t); await f.online(); let rounds = 0;
  f.setGenerate(async input => {
    if (++rounds === 1) { await held.wait(input.signal); return reply('OLD'); }
    const context = JSON.stringify(input.messages);
    assert.ok(context.includes('开心的小猫')); assert.ok(context.includes('明天下午三点见')); assert.ok(context.includes('🙂'));
    return reply('收到图和语音。');
  });
  message(f, 1, 'WAIT'); await until(() => rounds === 1);
  const png = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#ff9900' } }).png().toBuffer();
  f.send({ message_id: 2, message: [{ type: 'image', data: { url: 'base64://' + png.toString('base64') } }, { type: 'record', data: { file: 'synthetic-voice' } }, { type: 'text', data: { text: '🙂' } }] });
  await noticed(f, 2, 'merged'); held.release(); await noticed(f, 2, 'sent'); assert.equal(sends(f).length, 1);
});

test('different friends never share an input group, even when both use the same Web session', async t => {
  const held = gate(); t.after(held.release);
  const f = await fixture(t, { config: { allowedUsers: ['200002', '300003'] } }); await f.online(); let rounds = 0;
  f.setGenerate(async input => {
    if (++rounds === 1) { await held.wait(input.signal); return reply('OLD'); }
    return reply(rounds === 2 ? 'FRIEND_A' : 'FRIEND_B');
  });
  message(f, 1, 'A_START'); await until(() => rounds === 1);
  message(f, 2, 'B_SEPARATE', 300003); message(f, 3, 'A_SUPPLEMENT');
  await noticed(f, 3, 'merged'); held.release(); await noticed(f, 2, 'sent');
  assert.deepEqual(sends(f).map(c => [c.params.user_id, c.params.message[0].data.text]), [[200002, 'FRIEND_A'], [300003, 'FRIEND_B']]);
});

test('disabling merge retains independent replies and validates the setting', async t => {
  const held = gate(); t.after(held.release);
  const f = await fixture(t, { config: { mergeIncoming: false } }); await f.online(); let rounds = 0;
  assert.equal((await f.status()).incomingMerge.supported, true);
  assert.equal((await f.save({ mergeIncoming: 'yes' })).status, 400);
  f.setGenerate(async input => { if (++rounds === 1) { await held.wait(input.signal); return reply('FIRST'); } return reply('SECOND'); });
  message(f, 1, 'FIRST_INPUT'); await until(() => rounds === 1); message(f, 2, 'SECOND_INPUT');
  await until(async () => (await f.status()).queued === 2); held.release(); await noticed(f, 2, 'sent');
  assert.deepEqual(texts(f), ['FIRST', 'SECOND']);
});

test('stop cancels a grouped turn, preserves evidence and reload does not replay either member', async t => {
  const held = gate(); t.after(held.release);
  const f = await fixture(t); await f.online(); let rounds = 0;
  f.setGenerate(async input => { rounds++; await held.wait(input.signal); return reply('MUST_NOT_SEND'); });
  message(f, 1, 'FIRST'); await until(() => rounds === 1); message(f, 2, 'SUPPLEMENT'); await noticed(f, 2, 'merged');
  await f.app.runtime.action('qq', 'stop'); held.release();
  assert.equal(await f.app.runtime.services.get('witness')!.value.ping(), 'alive');
  await f.app.runtime.action('qq', 'start'); await f.online(); message(f, 1, 'FIRST'); message(f, 2, 'SUPPLEMENT');
  await until(async () => (await f.status()).queued === 0 && (await f.status()).recent.length >= 2);
  assert.equal(rounds, 1); assert.equal(sends(f).length, 0);
});
