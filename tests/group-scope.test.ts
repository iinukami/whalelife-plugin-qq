/*! Copyright (c) 2026 iinukami and contributors.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */
import assert from 'node:assert/strict';
import { setImmediate as nextTurn } from 'node:timers/promises';
import test from 'node:test';
import { GroupSubscription } from '../src/group-subscription.ts';
import type { GroupEvent } from '../src/group-events.ts';

const self = '100001', group = '200001', other = '200002';
function message(groupId: string, messageId: number, text = 'synthetic') {
  return { post_type: 'message', message_type: 'group', self_id: self, user_id: '300001',
    group_id: groupId, message_id: messageId, message: [{ type: 'text', data: { text } }] };
}
async function delivered(events: GroupEvent[], messageId: number) {
  for (let i = 0; i < 100 && !events.some(event => event.messageId === String(messageId)); i++) await nextTurn();
  assert.ok(events.some(event => event.messageId === String(messageId)), 'Expected trailing authorized event');
}

test('legacy subscriptions have no group scope and do not receive group content', async t => {
  const subscriptions = new GroupSubscription(), life = new AbortController(), events: GroupEvent[] = [];
  t.after(() => life.abort());
  assert.throws(() => subscriptions.signal(self));
  await assert.rejects(subscriptions.authorize(self, group));
  subscriptions.register(self, event => { events.push(event); }, { signal: life.signal });
  assert.equal(subscriptions.scope(self), 'missing');
  await assert.rejects(subscriptions.authorize(self, group));
  subscriptions.offer(message(group, 1, 'outside subscription'), self, life.signal);
  await nextTurn();
  assert.equal(events.length, 0);
  assert.equal(subscriptions.known(self, group, '1'), false);
});

test('scope is evaluated for each group and revocation affects the next notification and action', async t => {
  const subscriptions = new GroupSubscription(), life = new AbortController(), events: GroupEvent[] = [];
  t.after(() => life.abort());
  const allowed = new Set([group]);
  subscriptions.register(self, event => { events.push(event); }, { signal: life.signal, allowsGroup: id => allowed.has(id) });
  assert.equal(subscriptions.scope(self), 'scoped');
  await subscriptions.authorize(self, group);
  await assert.rejects(subscriptions.authorize(self, other));
  subscriptions.offer(message(other, 42, 'PRIVATE_SYNTHETIC_MARKER'), self, life.signal);
  subscriptions.offer(message(group, 42), self, life.signal);
  subscriptions.offer(message(group, 42), self, life.signal);
  subscriptions.offer(message(group, 43), self, life.signal);
  await delivered(events, 43);
  assert.deepEqual(events.map(e => e.messageId), ['42', '43']);
  assert.equal(subscriptions.known(self, group, '42'), true);
  assert.equal(subscriptions.known(self, other, '42'), false);
  assert.equal(subscriptions.known('100002', group, '42'), false);
  allowed.delete(group); allowed.add(other);
  await assert.rejects(subscriptions.authorize(self, group));
  subscriptions.offer(message(group, 44, 'PRIVATE_SYNTHETIC_MARKER'), self, life.signal);
  subscriptions.offer(message(other, 45), self, life.signal);
  await delivered(events, 45);
  assert.deepEqual(events.map(e => e.messageId), ['42', '43', '45']);
  assert.ok(!JSON.stringify(events).includes('PRIVATE_SYNTHETIC_MARKER'));
  assert.equal(subscriptions.known(self, group, '44'), false);
});

test('stopping a subscription withdraws scope, interrupts its work and clears prior quote evidence', async t => {
  const subscriptions = new GroupSubscription(), first = new AbortController(), next = new AbortController();
  const runtime = new AbortController(), firstEvents: GroupEvent[] = [], nextEvents: GroupEvent[] = [];
  t.after(() => { first.abort(); next.abort(); runtime.abort(); });
  const removeFirst = subscriptions.register(self, event => { firstEvents.push(event); },
    { signal: first.signal, allowsGroup: () => true });
  const signal = subscriptions.signal(self);
  subscriptions.offer(message(group, 51), self, runtime.signal);
  await delivered(firstEvents, 51);
  first.abort();
  assert.equal(signal.aborted, true);
  assert.throws(() => subscriptions.signal(self));
  await assert.rejects(subscriptions.authorize(self, group));
  subscriptions.register(self, event => { nextEvents.push(event); }, { signal: next.signal, allowsGroup: () => true });
  assert.equal(subscriptions.known(self, group, '51'), false);
  removeFirst();
  assert.equal(subscriptions.signal(self).aborted, false);
  subscriptions.offer(message(other, 52), self, runtime.signal);
  await delivered(nextEvents, 52);
  assert.deepEqual(firstEvents.map(e => e.messageId), ['51']);
  assert.deepEqual(nextEvents.map(e => e.messageId), ['52']);
  runtime.abort();
  subscriptions.offer(message(other, 53), self, runtime.signal);
  await nextTurn();
  assert.equal(subscriptions.known(self, other, '53'), false);
  assert.equal(nextEvents.length, 1);
});

test('a late grant cannot release a queued message after the receiving subscription has been replaced', async t => {
  const subscriptions = new GroupSubscription(), first = new AbortController(), next = new AbortController();
  const runtime = new AbortController(), oldEvents: GroupEvent[] = [], newEvents: GroupEvent[] = [];
  t.after(() => { first.abort(); next.abort(); runtime.abort(); });
  let notify!: () => void, allow!: (value: boolean) => void;
  const started = new Promise<void>(resolve => { notify = resolve; });
  const grant = new Promise<boolean>(resolve => { allow = resolve; });
  subscriptions.register(self, event => { oldEvents.push(event); }, { signal: first.signal,
    allowsGroup: () => { notify(); return grant; } });
  subscriptions.offer(message(group, 61), self, runtime.signal);
  await started;
  first.abort();
  subscriptions.register(self, event => { newEvents.push(event); }, { signal: next.signal, allowsGroup: () => true });
  allow(true);
  subscriptions.offer(message(group, 62), self, runtime.signal);
  await delivered(newEvents, 62);
  assert.equal(oldEvents.length, 0);
  assert.deepEqual(newEvents.map(e => e.messageId), ['62']);
  assert.equal(subscriptions.known(self, group, '61'), false);
});
