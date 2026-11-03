import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import type { Context, ChannelAdapter, OutgoingMessage } from 'whalelife';
import { QQRuntime } from '../src/runtime.ts';
import { QQError, defaults, segmentationDefaults } from '../src/config.ts';
import { textDeliveryReceipt } from '../src/text-delivery.ts';
import { fixture, until } from './fixture.ts';

const segmentedReply = { ...segmentationDefaults, enabled: true, interval: '0,0' };
const message: OutgoingMessage = { channel: 'qq', account: '100001', peer: 'direct:200002', sessionId: 'test',
  deliveryId: 'test-delivery', replyTo: '123', text: '第一句。第二句。第三句。' };

function transport(t: TestContext, failSave: (data: any) => boolean = () => false) {
  const controller = new AbortController(), stored = new Map<string, any>(), experiences: any[] = [];
  let adapter!: ChannelAdapter, sends = 0, request = async () => ({ message_id: ++sends });
  const ctx = { signal: controller.signal, channels: { register(value: ChannelAdapter) { adapter = value; return { dispose() {} }; } },
    config: { read: async (file: string) => structuredClone(stored.get(file) ?? {}), save: async (file: string, value: any) => {
      if (failSave(value)) throw Error('synthetic storage failure'); stored.set(file, structuredClone(value));
    } }, memory: { recordExperience: async (_session: string, value: any) => { experiences.push(value); } },
  } as unknown as Context;
  const runtime = new QQRuntime(ctx, { ...defaults, accountId: '100001', allowedUsers: ['200002'], minReplyIntervalMs: 0, segmentedReply });
  (runtime as any).bot.request = () => request();
  t.after(() => runtime.stop());
  return { runtime, stored, experiences, sends: () => sends, controller, ctx,
    setRequest(fn: typeof request) { request = fn; },
    send: (patch: Partial<OutgoingMessage> = {}, signal = controller.signal) => adapter.send({ ...message, ...patch }, { signal }),
    receipt: () => (runtime as any).deliveryResults.get(message.deliveryId),
  };
}

test('only affirmative no-send evidence is definite; old failed/malformed receipts stay unknown', () => {
  for (const part of [{ state: 'failed' }, { state: 'pending' }, { state: 'sent', messageId: '0' }]) {
    const receipt = textDeliveryReceipt({ version: 1, fingerprint: 'test', partCount: 3, parts: [part as any] });
    assert.equal(receipt.outcome, 'unknown'); assert.equal(receipt.unknownParts, 1); assert.equal(receipt.unattemptedParts, 2);
  }
  const receipt = textDeliveryReceipt({ version: 1, fingerprint: 'test', partCount: 3, parts: [{ state: 'failed', notSent: true }] });
  assert.equal(receipt.outcome, 'not_sent'); assert.equal(receipt.notSentParts, 3); assert.equal(receipt.readStatus, 'unknown');
});

for (const mode of ['not-sent', 'unknown', 'partial', 'partial-unknown', 'sent']) test(`transport preserves ${mode} facts across the host adapter boundary`, async t => {
  const f = transport(t); let calls = 0;
  f.setRequest(async () => {
    calls++;
    if (mode.startsWith('partial') && calls === 1 || mode === 'sent') return { message_id: calls };
    throw new QQError('platform_failed', 'synthetic failure', mode === 'not-sent' || mode === 'partial');
  });
  if (mode === 'sent') await f.send(); else await assert.rejects(f.send());
  const receipt = f.receipt();
  assert.equal(receipt.outcome, mode.startsWith('partial') ? 'partial' : mode === 'not-sent' ? 'not_sent' : mode);
  assert.equal(receipt.sentParts, mode === 'sent' ? 3 : mode.startsWith('partial') ? 1 : 0);
  assert.equal(receipt.unknownParts, mode.includes('unknown') ? 1 : 0);
  assert.equal(calls, mode === 'sent' ? 3 : mode.startsWith('partial') ? 2 : 1);
  assert.equal(f.experiences.length, mode === 'sent' ? 0 : 1);
  assert.ok(!JSON.stringify(f.experiences).includes(message.text));
});

test('pending storage failure is not submitted; acknowledged segments survive receipt write failure', async t => {
  const before = transport(t, data => data.parts?.some((p: any) => p.state === 'pending'));
  await assert.rejects(before.send()); assert.equal(before.sends(), 0); assert.equal(before.receipt().outcome, 'not_sent');
  const after = transport(t, data => data.parts?.some((p: any) => p.state === 'sent'));
  await assert.rejects(after.send()); assert.equal(after.sends(), 1);
  assert.equal(after.receipt().outcome, 'partial'); assert.equal(after.receipt().sentParts, 1); assert.equal(after.receipt().unknownParts, 0);
  const last = transport(t, data => data.parts?.some((p: any) => p.state === 'sent'));
  await last.send({ text: '一句。' }); assert.equal(last.receipt().outcome, 'sent'); assert.equal(last.sends(), 1);
});

test('memory projection failure never changes a platform result or replays an auto reply', async t => {
  const f = transport(t);
  f.ctx.memory.recordExperience = async () => { throw Error('synthetic memory failure'); };
  f.setRequest(async () => { throw new QQError('offline', 'synthetic offline', true); });
  await assert.rejects(f.send()); assert.equal(f.receipt().outcome, 'not_sent');
  assert.ok(f.runtime.recent.some(n => n.status === 'delivery_memory_unavailable'));
  assert.equal(f.sends(), 0);
});

test('host success survives stale private receipts; transient failure memory contains no reply text', async t => {
  const f = transport(t, data => data.parts?.some((p: any) => p.state === 'sent'));
  await f.send({ text: '一句。' });
  (f.runtime as any).deliveryResults.clear();
  const result = await (f.runtime as any).describeDelivery({ status: 'sent', deliveryId: message.deliveryId });
  assert.equal(result.delivery.outcome, 'sent'); assert.equal(result.delivery.sentParts, 1); assert.equal(f.sends(), 1);
  const missing = await (f.runtime as any).describeDelivery({ status: 'sent', deliveryId: 'old-missing-plan' });
  assert.equal(missing.delivery.outcome, 'sent'); assert.equal(missing.delivery.sentParts, null);
  const transient = transport(t);
  transient.setRequest(async () => { throw new QQError('offline', 'offline', true); });
  await assert.rejects(transient.send({ transient: true, text: 'TEMPORARY-THIRD-PARTY-TEXT' }));
  assert.ok(!JSON.stringify([...transient.stored.values(), ...transient.experiences]).includes('TEMPORARY-THIRD-PARTY-TEXT'));
});

test('cancellation between segments is partial with no unknown submitted segment', async t => {
  const f = transport(t); let calls = 0;
  f.setRequest(async () => { calls++; f.controller.abort(); return { message_id: 1 }; });
  await assert.rejects(f.send());
  assert.equal(calls, 1); assert.equal(f.receipt().outcome, 'partial'); assert.equal(f.receipt().unknownParts, 0);
  assert.equal(f.receipt().unattemptedParts, 2);
});

for (const mode of ['failed', 'timeout', 'missing-id']) test(`packaged tool reports ${mode} precisely and survives duplicate/reload without a resend`, async t => {
  const f = await fixture(t, { config: { permission: 'full', segmentedReply } }); await f.online();
  const sessionId = await f.app.sessions.current(); let calls = 0;
  f.setAction((data, socket) => {
    if (data.action !== 'send_private_msg') return false;
    if (++calls === 1) return false;
    if (mode !== 'timeout') socket.send(JSON.stringify({ echo: data.echo, status: mode === 'failed' ? 'failed' : 'ok',
      retcode: mode === 'failed' ? 1200 : 0, message: 'PRIVATE-ERROR-TEXT', data: {} }));
    return true;
  });
  const args = { userId: '200002', messageId: mode, text: message.text };
  const call = () => f.app.tools.call('qq_send_message', args, { id: sessionId, permission: 'full' });
  const result = (await call()).result;
  assert.equal(result.status, 'delivery_failed'); assert.equal(result.confirmed, false); assert.equal(result.retryAutomatically, false);
  assert.equal(result.delivery.outcome, 'partial'); assert.equal(result.delivery.sentParts, 1); assert.equal(result.delivery.unknownParts, 1);
  assert.equal(result.delivery.unattemptedParts, 1); assert.equal(result.delivery.readStatus, 'unknown');
  assert.ok(!JSON.stringify(result).includes('PRIVATE-ERROR-TEXT'));
  assert.ok(!result.error.includes('重试可能重复投递'));
  assert.deepEqual((await call()).result.delivery, result.delivery);
  await f.app.runtime.action('qq', 'reload'); await f.online();
  assert.deepEqual((await call()).result.delivery, result.delivery); assert.equal(calls, 2);
});

test('auto reply offline is recorded once and available to the next model turn, without replay', async t => {
  const f = await fixture(t, { config: { segmentedReply } }); await f.online();
  f.setGenerate(async () => {
    f.socket().terminate(); await until(async () => (await f.status()).state === 'disconnected');
    return { text: message.text, toolCalls: [] };
  });
  f.send(); await until(async () => (await f.status()).recent.some((n: any) => n.status === 'delivery_failed'));
  assert.equal(f.calls.filter(c => c.action === 'send_private_msg').length, 0);
  const id = await f.app.sessions.current();
  const experiences = (await f.app.memoryEngine.state(id)).records.filter((r: any) => r.source === 'qq' && r.text.includes('自动回复投递结果'));
  assert.equal(experiences.length, 1); assert.match(experiences[0].text, /明确未发出.*确认发送 0 段.*明确未发送 3 段/);
  await f.app.runtime.action('qq', 'reload'); await f.online(); f.send();
  await until(async () => (await f.status()).recent.some((n: any) => n.status === 'delivery_failed'));
  assert.equal((await f.app.memoryEngine.state(id)).records.filter((r: any) => r.source === 'qq').length, 1);
  f.setGenerate(async input => {
    assert.match(JSON.stringify(input.messages), /QQ 自动回复投递结果.*明确未发出/);
    return { text: '新的正常回复。', toolCalls: [] };
  });
  f.send({ message_id: 2, message: [{ type: 'text', data: { text: '刚才 QQ 自动回复投递结果如何，发出了几段？' } }] });
  await until(async () => (await f.status()).recent.some((n: any) => n.messageId === '2' && n.status === 'sent'));
  assert.equal(f.calls.filter(c => c.action === 'send_private_msg').length, 1);
});
