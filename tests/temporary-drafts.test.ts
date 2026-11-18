/*! Copyright (c) 2026 iinukami and contributors.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TemporaryDrafts } from '../src/temporary-drafts.ts';
import type { Delivery } from '../src/text-delivery.ts';

const key = { sessionId: 'session-a', accountId: '100001', deliveryId: 'delivery-a' };
const recipient = '200002';
const allowed = (id: string) => id === recipient;
const original = ['confirmed', 'declined', 'never submitted'];
const ttl = 12 * 60 * 60 * 1000;
const receipt = (): Delivery => ({
  version: 1, fingerprint: 'a'.repeat(64), transient: true, partCount: original.length,
  parts: [{ state: 'sent', messageId: '9001' }, { state: 'failed', notSent: true }],
});

test('one claim returns frozen unsent segments only and a duplicate offer cannot replace or reissue them', t => {
  const drafts = new TemporaryDrafts(); t.after(() => drafts.clear());
  const texts = [...original];
  drafts.offer(key, recipient, texts, receipt()); texts[1] = 'changed after offer';
  const replacement = original.map(() => 'different draft');
  drafts.offer(key, recipient, replacement, receipt());
  const result = drafts.claim(key, allowed);
  assert.equal(result.status, 'claimed');
  if (result.status !== 'claimed') throw Error('Missing expected draft');
  assert.deepEqual(result.parts, [{ index: 2, text: 'declined' }, { index: 3, text: 'never submitted' }]);
  assert.ok(Number.isFinite(Date.parse(result.expiresAt)));
  drafts.offer(key, recipient, replacement, receipt());
  assert.equal(drafts.claim(key, allowed).status, 'unavailable');
  assert.equal(drafts.release(key).status, 'released');
  assert.equal(drafts.release(key).status, 'unavailable');
});

test('sent, ambiguous, normal and malformed plans never expose a temporary draft', t => {
  const drafts = new TemporaryDrafts(); t.after(() => drafts.clear());
  const cases: [string, Partial<Delivery>][] = [
    ['complete', { parts: original.map((_, i) => ({ state: 'sent', messageId: String(9000 + i) })) }],
    ['pending', { parts: [{ state: 'pending' }] }],
    ['generic-failure', { parts: [{ state: 'failed' }] }],
    ['missing-platform-id', { parts: [{ state: 'sent' }] }],
    ['null-slot', { parts: [null] as unknown as Delivery['parts'] }],
    ['normal', { transient: undefined }],
    ['mismatched-count', { partCount: 2 }],
    ['extra-receipt', { parts: Array.from({ length: 4 }, () => ({ state: 'failed', notSent: true })) }],
  ];
  for (const [deliveryId, values] of cases) {
    const k = { ...key, deliveryId };
    drafts.offer(k, recipient, original, { ...receipt(), ...values });
    assert.equal(drafts.claim(k, allowed).status, 'unavailable', deliveryId);
  }
});

test('scope and recipient are enforced for reads, and one session cannot release another session’s draft', t => {
  const drafts = new TemporaryDrafts(); t.after(() => drafts.clear());
  drafts.offer(key, recipient, original, receipt());
  for (const different of [{ sessionId: 'session-b' }, { accountId: '100002' }, { deliveryId: 'delivery-b' }]) {
    const wrong = { ...key, ...different };
    assert.equal(drafts.claim(wrong, allowed).status, 'unavailable');
    assert.equal(drafts.release(wrong).status, 'unavailable');
  }
  assert.equal(drafts.claim(key, () => false).status, 'unavailable');
});

test('an unclaimed draft can be explicitly discarded, and clear drops other outstanding bodies', () => {
  const drafts = new TemporaryDrafts(), other = { ...key, deliveryId: 'delivery-b' };
  drafts.offer(key, recipient, original, receipt()); drafts.offer(other, recipient, original, receipt());
  assert.equal(drafts.release(key).status, 'released');
  assert.equal(drafts.claim(key, allowed).status, 'unavailable');
  drafts.clear(); assert.equal(drafts.claim(other, allowed).status, 'unavailable');
});

test('the expiry timer drops idle drafts even without a read at their deadline', t => {
  const start = Date.parse('2026-01-01T00:00:00Z');
  t.mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'], now: start });
  const drafts = new TemporaryDrafts(); t.after(() => drafts.clear());
  drafts.offer(key, recipient, original, receipt());
  t.mock.timers.tick(ttl);
  // Rolling back time after the deadline catches implementations that check only during claim.
  t.mock.timers.setTime(start + 1);
  assert.equal(drafts.claim(key, allowed).status, 'unavailable');
});

test('when 33 deliveries are interrupted the oldest of the 32 retained slots is evicted', t => {
  const drafts = new TemporaryDrafts(); t.after(() => drafts.clear());
  for (let i = 0; i < 33; i++) {
    drafts.offer({ ...key, deliveryId: String(i) }, recipient, original, receipt());
  }
  assert.equal(drafts.claim({ ...key, deliveryId: '0' }, allowed).status, 'unavailable');
  for (let i = 1; i < 33; i++) {
    assert.equal(drafts.claim({ ...key, deliveryId: String(i) }, allowed).status, 'claimed', String(i));
  }
});
