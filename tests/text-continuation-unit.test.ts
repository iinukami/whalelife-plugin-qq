import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Context, OutgoingMessage, ChannelResult } from 'whalelife';
import { TextContinuations, textDeliveryError } from '../src/text-continuation.ts';
import { digest } from '../src/messages.ts';
import { QQRuntime } from '../src/runtime.ts';
import { defaults } from '../src/config.ts';

const original = 'SYNTHETIC-REPLY-FIRST。SYNTHETIC-REPLY-SECOND。';
const message = (deliveryId = 'delivery-a', sessionId = 'session-a'): OutgoingMessage => ({
  channel: 'qq', account: '100001', peer: 'direct:200002', sessionId, deliveryId, replyTo: '321', text: original,
});
const key = (deliveryId = 'delivery-a', sessionId = 'session-a') => ({ deliveryId, sessionId });
const entryFile = (deliveryId = 'delivery-a') => `text-continuation-${digest(deliveryId)}.json`;
const ledgerFile = (deliveryId = 'delivery-a') => `delivery-${digest(deliveryId)}.json`;
const indexFile = `text-continuations-${digest('100001')}.json`;
function fixture() {
  const stored = new Map<string, any>(), events: { name: string; data: any }[] = [];
  let fail: (file: string, data: any) => boolean = () => false;
  let guard: string | undefined;
  const ctx = { config: {
    read: async (file: string) => structuredClone(stored.get(file) ?? {}),
    save: async (file: string, value: any) => {
      if (fail(file, value)) throw Error('SYNTHETIC-STORAGE-FAILURE');
      stored.set(file, structuredClone(value));
    },
  }, emit: (name: string, data: any) => { events.push({ name, data: structuredClone(data) }); } } as unknown as Context;
  const create = (accountId = '100001') => new TextContinuations(ctx, accountId, async () => guard);
  const api = create();
  const putLedger = (deliveryId = 'delivery-a', parts: any[] = [{ state: 'sent', messageId: '9001' }, { state: 'failed', notSent: true }]) => {
    stored.set(ledgerFile(deliveryId), { version: 1, fingerprint: digest(['direct:200002', original]),
      texts: ['SYNTHETIC-REPLY-FIRST。', 'SYNTHETIC-REPLY-SECOND。'], intervals: [0, 0], partCount: 2, parts });
  };
  const start = async (deliveryId = 'delivery-a', sessionId = 'session-a') => {
    putLedger(deliveryId); await api.begin(message(deliveryId, sessionId), { messageId: '321', direction: 'in' }, true);
  };
  const settle = (status: ChannelResult['status'] = 'delivery_failed', deliveryId = 'delivery-a', sessionId = 'session-a') =>
    api.settle({ ...key(deliveryId, sessionId), messageId: '321', status });
  return { stored, events, api, create, putLedger, start, settle,
    failSave(fn: typeof fail) { fail = fn; }, block(reason: string | undefined) { guard = reason; } };
}
async function reason(promise: Promise<unknown>) {
  try { await promise; }
  catch (error) { return textDeliveryError(error).reason; }
  assert.fail('expected a blocked operation');
}

test('old, transient and unowned deliveries do not create persistent continuation content', async () => {
  const f = fixture();
  await f.api.begin(message(), { messageId: '321', direction: 'in' }, false);
  await f.api.begin(message(), undefined, true);
  await f.api.begin({ ...message(), transient: true }, { messageId: '321', direction: 'in' }, true);
  assert.equal(f.stored.size, 0); assert.equal(f.events.length, 0);
  f.putLedger();
  assert.equal(await reason(f.api.get(key())), 'not_found');
  assert.deepEqual((await f.api.list({ sessionId: 'session-a' })).items, []);
});

test('metadata and notifications contain no original reply; lists omit text while details retain frozen parts', async () => {
  const f = fixture(); await f.start(); await f.settle();
  assert.ok(!JSON.stringify(f.stored.get(entryFile())).includes('SYNTHETIC-REPLY'));
  assert.ok(!JSON.stringify(f.stored.get(indexFile)).includes('SYNTHETIC-REPLY'));
  assert.ok(!JSON.stringify(f.events).includes('SYNTHETIC-REPLY'));
  const list = await f.api.list({ sessionId: 'session-a' });
  assert.equal(list.items.length, 1); assert.equal(list.items[0].canResume, true);
  assert.ok(!JSON.stringify(list).includes('SYNTHETIC-REPLY'));
  const item = (await f.api.get(key())).item;
  assert.deepEqual(item.parts?.map(p => p.text), ['SYNTHETIC-REPLY-FIRST。', 'SYNTHETIC-REPLY-SECOND。']);
  assert.deepEqual(item.parts?.map(p => p.state), ['sent', 'not_sent']);
});

for (const point of ['entry', 'index']) test(`failure saving ${point} rejects begin before a caller can submit`, async () => {
  const f = fixture(); let submitted = 0;
  f.failSave(file => point === 'entry' ? file === entryFile() : file === indexFile);
  await assert.rejects(async () => {
    await f.api.begin(message(), { messageId: '321', direction: 'in' }, true);
    submitted++;
  }, /SYNTHETIC-STORAGE-FAILURE/);
  assert.equal(submitted, 0);
  assert.equal(f.events.length, 0);
});

test('unfinished in-process tasks become unknown after reconstruction and cannot be claimed', async () => {
  const f = fixture(); await f.start();
  assert.equal((await f.api.get(key())).item.state, 'in_progress');
  const resumed = f.create(), snapshot = (await resumed.get(key())).item;
  assert.equal(snapshot.state, 'unknown'); assert.equal(snapshot.canResume, false);
  assert.equal(await reason(resumed.claim({ ...key(), expectedRevision: snapshot.revision })), 'unknown');
});

test('durable known failure survives reconstruction while host uncertainty never becomes resumable', async () => {
  const f = fixture(); await f.start(); await f.settle();
  const resumed = f.create(); assert.equal((await resumed.get(key())).item.canResume, true);
  await f.settle('uncertain');
  assert.equal((await resumed.get(key())).item.state, 'unknown');
  assert.equal((await resumed.get(key())).item.canResume, false);
});

for (const part of [{ state: 'failed' }, { state: 'pending' }, { state: 'sent', messageId: '0' }, { state: 'unexpected' }])
  test(`ambiguous or invalid ${JSON.stringify(part)} cannot be resumed`, async () => {
    const f = fixture(); await f.start(); f.putLedger('delivery-a', [part]); await f.settle();
    const item = (await f.api.get(key())).item;
    assert.equal(item.state, 'unknown'); assert.equal(item.canResume, false);
    assert.equal(await reason(f.api.claim({ ...key(), expectedRevision: item.revision })), 'unknown');
  });

test('explicit null ledger entries are corrupt rather than evidence of unattempted delivery', async () => {
  const f = fixture(); await f.start(); f.putLedger('delivery-a', [null]); await f.settle();
  const item = (await f.api.get(key())).item;
  assert.equal(item.state, 'unknown'); assert.equal(item.canResume, false);
});

test('host sent is authoritative even if the private segment receipt is stale, and does not replay', async () => {
  const f = fixture(); await f.start(); f.putLedger('delivery-a', [{ state: 'pending' }]); await f.settle('sent');
  assert.equal((await f.api.list({ sessionId: 'session-a' })).items.length, 0);
  const item = (await f.api.get(key())).item;
  assert.equal(item.state, 'sent'); assert.equal(item.delivery.outcome, 'sent');
  assert.equal(item.delivery.unknownParts, 0); assert.equal(item.canResume, false);
  const claim = await f.api.claim({ ...key(), expectedRevision: item.revision });
  assert.equal(claim.entry, undefined); assert.equal(claim.item.state, 'sent');
});

test('same-revision concurrent decisions admit exactly one claim and settlement invalidates the old revision', async () => {
  const f = fixture(); await f.start(); await f.settle();
  const item = (await f.api.get(key())).item, decision = { ...key(), expectedRevision: item.revision };
  const results = await Promise.allSettled([f.api.claim(decision), f.api.claim(decision)]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(results.filter(r => r.status === 'rejected').length, 1);
  const rejected = results.find(r => r.status === 'rejected') as PromiseRejectedResult;
  assert.equal(textDeliveryError(rejected.reason).reason, 'stale_revision');
  await f.settle(); assert.notEqual((await f.api.get(key())).item.revision, item.revision);
  assert.equal(await reason(f.api.claim(decision)), 'stale_revision');
});

test('claim storage failure leaves the accepted revision unchanged and does not mark an active task', async () => {
  const f = fixture(); await f.start(); await f.settle();
  const item = (await f.api.get(key())).item;
  f.failSave((file, value) => file === entryFile() && value.phase === 'in_progress');
  assert.equal(await reason(f.api.claim({ ...key(), expectedRevision: item.revision })), 'storage');
  f.failSave(() => false);
  const after = (await f.api.get(key())).item;
  assert.equal(after.revision, item.revision); assert.equal(after.canResume, true);
});

test('list pagination is session-scoped and lookup rejects another session or account', async () => {
  const f = fixture();
  for (const id of ['delivery-a', 'delivery-b', 'delivery-c']) { await f.start(id); await f.settle('delivery_failed', id); }
  await f.start('delivery-other', 'session-b'); await f.settle('delivery_failed', 'delivery-other', 'session-b');
  const first = await f.api.list({ sessionId: 'session-a', limit: 2 });
  assert.equal(first.items.length, 2); assert.ok(first.nextCursor);
  const second = await f.api.list({ sessionId: 'session-a', limit: 2, cursor: first.nextCursor });
  assert.equal(second.items.length, 1); assert.equal(second.nextCursor, undefined);
  assert.equal(new Set([...first.items, ...second.items].map(i => i.deliveryId)).size, 3);
  assert.equal(await reason(f.api.get(key('delivery-a', 'session-b'))), 'not_found');
  assert.equal(await reason(f.create('100009').get(key())), 'not_found');
  assert.equal(await reason(f.api.list({ sessionId: 'session-a', limit: 51 })), 'invalid_input');
  assert.equal(await reason(f.api.list({ sessionId: 'session-a', cursor: '0'.repeat(64) })), 'stale_revision');
});

test('corrupt metadata or transient-corrupted ledger cannot expose text or admit a resume', async () => {
  const f = fixture(); await f.start(); await f.settle();
  const saved = f.stored.get(entryFile()); f.stored.set(entryFile(), { ...saved, peer: 'group:12345' });
  assert.equal(await reason(f.api.get(key())), 'storage');
  f.stored.set(entryFile(), saved);
  f.stored.get(ledgerFile()).transient = true;
  const item = (await f.api.get(key())).item;
  assert.equal(item.state, 'unknown'); assert.equal(item.parts, undefined);
  assert.equal(item.canResume, false);
});

test('dismiss blocks future claims and releases the list without removing original text', async () => {
  const f = fixture(); await f.start(); await f.settle();
  const item = (await f.api.get(key())).item;
  const result = await f.api.dismiss({ ...key(), expectedRevision: item.revision });
  assert.equal(result.status, 'dismissed'); assert.equal(result.confirmed, false);
  assert.equal((await f.api.list({ sessionId: 'session-a' })).items.length, 0);
  assert.ok(f.stored.get(ledgerFile()).texts[0].includes('SYNTHETIC-REPLY'));
  assert.equal(await reason(f.api.claim({ ...key(), expectedRevision: result.item.revision })), 'dismissed');
});

test('a changed guard is evaluated again at claim and prevents side effects', async () => {
  const f = fixture(); await f.start(); await f.settle();
  const item = (await f.api.get(key())).item; assert.equal(item.canResume, true);
  for (const blocked of ['offline', 'permission', 'recipient', 'session_changed']) {
    f.block(blocked);
    assert.equal(await reason(f.api.claim({ ...key(), expectedRevision: item.revision })), blocked);
    assert.equal((await f.api.get(key())).item.revision, item.revision);
  }
});

test('confirmed sent cannot be downgraded by a late failed result or follow-up read failure', async () => {
  const f = fixture(); await f.start(); await f.settle('sent');
  const confirmed = (await f.api.get(key())).item;
  await f.settle('delivery_failed');
  assert.equal((await f.api.get(key())).item.state, 'sent');
  assert.equal((await f.api.get(key())).item.revision, confirmed.revision);
  await f.api.hostBlocked(key());
  assert.equal((await f.api.get(key())).item.state, 'sent');
  assert.equal((await f.api.get(key())).item.revision, confirmed.revision);
  assert.equal((await f.api.list({ sessionId: 'session-a' })).items.length, 0);
});

test('strict decision inputs cannot override target, text, account or session routing', async () => {
  const f = fixture(); await f.start(); await f.settle();
  const item = (await f.api.get(key())).item;
  for (const override of [{ userId: '300003' }, { text: 'REPLACEMENT' }, { accountId: '100009' }, { peer: 'direct:300003' }]) {
    assert.equal(await reason(f.api.claim({ ...key(), expectedRevision: item.revision, ...override })), 'invalid_input');
    assert.equal((await f.api.get(key())).item.revision, item.revision);
  }
});

test('direct delivery source is confirmed by the matching host result rather than ambient caller metadata', async () => {
  const f = fixture(); f.putLedger();
  await f.api.begin({ ...message(), replyTo: undefined }, { messageId: 'ambient-wrong-id', direction: 'out' }, true);
  assert.equal((await f.api.get(key())).item.canResume, false);
  await f.api.settle({ ...key(), messageId: 'authoritative-host-id', status: 'delivery_failed' });
  const item = (await f.api.get(key())).item;
  assert.equal(item.canResume, true);
  const claim = await f.api.claim({ ...key(), expectedRevision: item.revision });
  assert.equal(claim.entry?.messageId, 'authoritative-host-id');
  assert.equal(claim.entry?.direction, 'out');
});

test('merged incoming result keeps the original canonical replyTo rather than a member ID', async () => {
  const f = fixture(); await f.start();
  await f.api.settle({ ...key(), messageId: 'merged-member-id', status: 'delivery_failed' });
  const item = (await f.api.get(key())).item;
  const claim = await f.api.claim({ ...key(), expectedRevision: item.revision });
  assert.equal(claim.entry?.messageId, '321'); assert.equal(claim.entry?.direction, 'in');
});

test('runtime preserves confirmed host success when only its follow-up detail read fails', async t => {
  const controller = new AbortController(); let retries = 0, blocked = 0, settled = 0;
  const ctx = { signal: controller.signal,
    config: { read: async () => ({}), save: async () => {} },
    channels: { register: () => ({ dispose() {}, retry: async () => {
      retries++; return { ...key(), messageId: '321', status: 'sent' };
    } }) }, logger: { warn() {} }, emit() {},
  } as unknown as Context;
  const runtime = new QQRuntime(ctx, { ...defaults, accountId: '100001', allowedUsers: ['200002'] });
  t.after(() => runtime.stop());
  (runtime as any).continuations = {
    claim: async () => ({ entry: { ...key(), peer: 'direct:200002', messageId: '321', direction: 'in' } }),
    settle: async () => { settled++; },
    get: async () => { throw Error('SYNTHETIC-READ-FAILURE-AFTER-CONFIRMED-SEND'); },
    hostBlocked: async () => { blocked++; },
  };
  const result = await runtime.resumeTextDelivery({ ...key(), expectedRevision: 'synthetic-revision' }, { signal: controller.signal });
  assert.equal(result.status, 'sent'); assert.equal(result.confirmed, true);
  assert.equal(retries, 1); assert.equal(settled, 1); assert.equal(blocked, 0);
});
