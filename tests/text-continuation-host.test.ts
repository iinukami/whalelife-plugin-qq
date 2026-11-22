/*! Copyright (c) 2026 iinukami and contributors.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { fixture, until } from './fixture.ts';
import { temporaryDirectory } from './temporary-directory.ts';
import { segmentationDefaults } from '../src/config.ts';

type Fixture = Awaited<ReturnType<typeof fixture>>;
const hostBoot = process.env.QQ_CONTINUATION_HOST_PATH
  ? (await import(pathToFileURL(resolve(process.env.QQ_CONTINUATION_HOST_PATH, 'core/index.ts')).href)).boot
  : undefined;
if (hostBoot !== undefined && typeof hostBoot !== 'function') throw Error('Selected isolated host has no boot function');
const text = '第一句。第二句。第三句。';
const config = { permission: 'full' as const, segmentedReply: {
  ...segmentationDefaults, enabled: true, onlyLLMResult: false, interval: '0.6,0.6', maxLength: 32000,
} };
const service = (f: Fixture) => f.app.runtime.services.get('qq')!.value;
const sends = (f: Fixture) => f.calls.filter(c => c.action === 'send_private_msg');
const sentText = (f: Fixture) => sends(f).map(c => c.params.message[0].data.text);
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const key = (item: any) => ({ sessionId: item.sessionId, deliveryId: item.deliveryId, expectedRevision: item.revision });
const options = () => ({ signal: new AbortController().signal });
function requiresResume(t: TestContext, f: Fixture) {
  if (service(f).textDeliveryResumeSupported) return true;
  t.skip('Selected host lacks the current-session contract; explicit host_blocked behavior is tested separately.'); return false;
}

async function make(t: TestContext, observe = false, withoutCurrentSession = false) {
  const f = await fixture(t, { config, includeQzone: false, temporaryDirectory, hostBoot,
    preparePlugin: withoutCurrentSession ? async root => {
      // Exercise the real QQ entry with a compatible host facade missing only the optional current-session API.
      await writeFile(join(root, 'index.ts'), `import { apply as applyQQ } from './main.js';
export function apply(ctx) {
  if (ctx.channels.supportsActivePersona !== true || typeof ctx.sessions.current !== 'function')
    throw Error('Expected the full host before removing the optional test capability');
  const sessions = Object.create(ctx.sessions, { current: { value: undefined } });
  return applyQQ({ ...ctx, sessions });
}`);
    } : undefined,
    ...(observe ? { prepareHost: async (root: string) => {
      const dir = join(root, 'plugins/continuation-observer'); await mkdir(dir, { recursive: true });
      await writeFile(join(dir, 'plugin.yaml'), 'id: continuation-observer\nname: Continuation observer\nversion: 1.0.0\ndescription: Isolated optional consumer\noptionalDepends: [qq]\n');
      await writeFile(join(dir, 'index.ts'), `export function apply(ctx) {
        let binding; const bindings = [], events = [];
        const optionalSupported = typeof ctx.optional === 'function';
        if (optionalSupported) ctx.optional('qq', value => {
          binding = value; bindings.push(!!value);
          if (!value) return;
          for (const name of ['plugin:qq:connection-changed', 'plugin:qq:text-delivery-changed'])
            value.effect(() => ctx.on(name, data => { events.push({ name, data }); }));
        });
        ctx.provide('continuation-observer', {
          snapshot: () => ({ optionalSupported, connected: !!binding, bindings, events }),
          list: input => binding ? binding.service.listTextDeliveries(input) : { status: 'unavailable' },
          resume: input => binding ? binding.service.resumeTextDelivery(input, { signal: binding.signal }) : { status: 'unavailable' },
        });
      }`);
    } } : {}),
  });
  await f.online();
  // Without a current-session API, a synthetic send establishes the direct route.
  const supportsCurrent = !withoutCurrentSession && typeof f.app.sessions.current === 'function';
  const sessionId = supportsCurrent ? await f.app.sessions.current()
    : (await service(f).sendText({ userId: '200002', messageId: 'fixture-route-setup', text: '隔离渠道准备' })).sessionId;
  assert.equal(typeof sessionId, 'string');
  f.calls.length = 0; f.generations.length = 0;
  assert.equal(service(f).textDeliveryApiVersion, '1.0.0');
  assert.equal(service(f).textDeliveryResumeSupported, supportsCurrent);
  f.setGenerate(async () => ({ text, toolCalls: [], usage: { prompt_tokens: 1, completion_tokens: 3 } }));
  return { f, sessionId };
}

async function itemFor(f: Fixture, sessionId: string) {
  const list = await service(f).listTextDeliveries({ sessionId });
  assert.equal(list.status, 'ok'); assert.equal(list.items.length, 1);
  assert.ok(!JSON.stringify(list).includes('第一句'), 'list is metadata only');
  const detail = await service(f).textDelivery({ sessionId, deliveryId: list.items[0].deliveryId });
  assert.equal(detail.status, 'ok'); return detail.item;
}

async function interruptAfterFirst(f: Fixture, sessionId: string, direct = false) {
  const connections = f.connects();
  const result = direct ? service(f).sendText({ userId: '200002', messageId: 'direct-continuation', text }) : undefined;
  if (!direct) f.send({ message_id: 701 });
  await until(() => sends(f).length === 1);
  // Wait for the actual platform success to be durably represented, not just the
  // socket request, before simulating a network loss between planned segments.
  await until(async () => {
    const list = await service(f).listTextDeliveries({ sessionId });
    if (list.status !== 'ok' || list.items.length !== 1) return false;
    const detail = await service(f).textDelivery({ sessionId, deliveryId: list.items[0].deliveryId });
    return detail.status === 'ok' && detail.item.delivery.sentParts === 1;
  });
  f.socket().terminate();
  if (result) assert.equal((await result).status, 'delivery_failed');
  else await until(async () => (await f.status()).recent.some((n: any) => n.messageId === '701' && n.status === 'delivery_failed'));
  await until(() => f.connects() > connections); await f.online();
  await pause(700);
  assert.deepEqual(sentText(f), ['第一句。'], 'connection recovery never submits the remainder');
  const item = await itemFor(f, sessionId);
  assert.equal(item.state, 'incomplete'); assert.equal(item.canResume, service(f).textDeliveryResumeSupported);
  assert.equal(item.delivery.sentParts, 1); assert.equal(item.delivery.unknownParts, 0);
  assert.equal(item.delivery.notSentParts, 2);
  assert.deepEqual(item.parts.map((part: any) => [part.text, part.state]), [
    ['第一句。', 'sent'], ['第二句。', 'not_sent'], ['第三句。', 'not_sent'],
  ]);
  assert.ok(item.parts[0].messageId);
  return item;
}

test('ordinary replies still work without autonomy and leave no unfinished item', { timeout: 15000 }, async t => {
  const { f, sessionId } = await make(t); f.send({ message_id: 700 });
  await until(async () => (await f.status()).recent.some((n: any) => n.messageId === '700' && n.status === 'sent'));
  assert.deepEqual(sentText(f), ['第一句。', '第二句。', '第三句。']);
  assert.equal(f.generations.length, 1); assert.equal(f.modelCalls.length, 0);
  assert.deepEqual((await service(f).listTextDeliveries({ sessionId })).items, []);
  assert.equal(await f.app.runtime.services.get('witness')!.value.ping(), 'alive');
});

for (const direct of [false, true]) test(`${direct ? 'direct send' : 'automatic reply'} resumes only unsent original parts, despite duplicate concurrent requests`, { timeout: 25000 }, async t => {
  const { f, sessionId } = await make(t);
  if (!requiresResume(t, f)) return;
  const item = await interruptAfterFirst(f, sessionId, direct);
  const generations = f.generations.length;
  const results = await Promise.all([
    service(f).resumeTextDelivery(key(item), options()), service(f).resumeTextDelivery(key(item), options()),
  ]);
  assert.ok(results.some(result => result.status === 'sent' && result.confirmed));
  assert.ok(results.every(result => result.status === 'sent' || result.status === 'blocked'));
  assert.deepEqual(sentText(f), ['第一句。', '第二句。', '第三句。']);
  assert.equal(f.generations.length, generations); assert.equal(f.modelCalls.length, 0);
  const done = await service(f).textDelivery({ sessionId, deliveryId: item.deliveryId });
  assert.equal(done.item.state, 'sent'); assert.equal(done.item.delivery.sentParts, 3);
  assert.deepEqual((await service(f).listTextDeliveries({ sessionId })).items, []);
  await service(f).resumeTextDelivery(key(item), options());
  assert.equal(sends(f).length, 3, 'stale completion cannot resend successful parts');
  await f.app.runtime.action('qq', 'reload'); await f.online();
  assert.equal((await service(f).textDelivery({ sessionId, deliveryId: item.deliveryId })).item.state, 'sent');
  assert.equal(sends(f).length, 3);
});

test('reload preserves incomplete work; cancelled, stale and dismissed requests never dispatch', { timeout: 25000 }, async t => {
  const { f, sessionId } = await make(t); if (!requiresResume(t, f)) return;
  const original = await interruptAfterFirst(f, sessionId);
  await f.app.runtime.action('qq', 'reload'); await f.online(); await pause(700);
  assert.equal(sends(f).length, 1);
  const item = await itemFor(f, sessionId); assert.equal(item.deliveryId, original.deliveryId);
  assert.equal(item.canResume, true);
  const controller = new AbortController(); controller.abort();
  await service(f).resumeTextDelivery(key(item), { signal: controller.signal }).catch(() => {});
  assert.equal(sends(f).length, 1);
  const stale = await service(f).resumeTextDelivery({ ...key(item), expectedRevision: 'stale-synthetic-revision' }, options());
  assert.equal(stale.status, 'blocked'); assert.equal(stale.reason, 'stale_revision');
  const current = await itemFor(f, sessionId);
  const dismissed = await service(f).dismissTextDelivery(key(current));
  assert.equal(dismissed.status, 'dismissed'); assert.equal(dismissed.confirmed, false);
  assert.deepEqual((await service(f).listTextDeliveries({ sessionId })).items, []);
  const after = await service(f).textDelivery({ sessionId, deliveryId: item.deliveryId });
  assert.equal(after.item.state, 'dismissed'); assert.equal(after.item.delivery.sentParts, 1);
  assert.deepEqual(after.item.parts.map((part: any) => part.text), ['第一句。', '第二句。', '第三句。']);
  assert.equal((await service(f).resumeTextDelivery(key(after.item), options())).status, 'blocked');
  assert.equal(sends(f).length, 1);
});

test('a generic failed platform envelope stays unknown and cannot be resumed or retargeted', { timeout: 20000 }, async t => {
  const { f, sessionId } = await make(t); let attempts = 0;
  if (!requiresResume(t, f)) return;
  f.setAction((data, socket) => {
    if (data.action !== 'send_private_msg' || ++attempts !== 2) return false;
    socket.send(JSON.stringify({ echo: data.echo, status: 'failed', retcode: 1200, message: 'PRIVATE-PROTOCOL-ERROR', data: {} }));
    return true;
  });
  f.send({ message_id: 702 });
  await until(async () => (await f.status()).recent.some((n: any) => n.messageId === '702' && n.status === 'delivery_failed'));
  const item = await itemFor(f, sessionId);
  assert.equal(item.state, 'unknown'); assert.equal(item.canResume, false);
  assert.equal(item.delivery.sentParts, 1); assert.equal(item.delivery.unknownParts, 1);
  const resumed = await service(f).resumeTextDelivery(key(item), options());
  assert.equal(resumed.status, 'blocked'); assert.equal(resumed.reason, 'unknown');
  assert.ok(!JSON.stringify(resumed).includes('PRIVATE-PROTOCOL-ERROR'));
  const other = await f.app.sessions.create('Other synthetic session');
  assert.equal((await service(f).textDelivery({ sessionId: other, deliveryId: item.deliveryId })).reason, 'not_found');
  assert.equal((await service(f).resumeTextDelivery({ ...key(item), userId: '300003' }, options())).status, 'blocked');
  await f.app.runtime.action('qq', 'reload'); await f.online();
  assert.equal((await itemFor(f, sessionId)).state, 'unknown'); assert.equal(sends(f).length, 2);
});

test('selection, permission and whitelist changes block continuation without rebinding old work', { timeout: 25000 }, async t => {
  const { f, sessionId } = await make(t); if (!requiresResume(t, f)) return;
  const item = await interruptAfterFirst(f, sessionId);
  const other = await f.app.sessions.create('Other synthetic session');
  await f.request('/api/session/current', { id: other });
  assert.equal((await service(f).resumeTextDelivery(key(item), options())).reason, 'session_changed');
  assert.equal(await f.app.sessions.current(), other);
  await f.request('/api/session/current', { id: sessionId });
  assert.equal((await f.save({ permission: 'off' })).status, 200); await f.online();
  assert.equal((await service(f).resumeTextDelivery(key(await itemFor(f, sessionId)), options())).reason, 'permission');
  assert.equal((await f.save({ permission: 'full', allowedUsers: ['300003'] })).status, 200); await f.online();
  const blocked = await service(f).resumeTextDelivery(key(item), options());
  assert.equal(blocked.status, 'blocked'); assert.equal(blocked.reason, 'recipient');
  assert.equal(sends(f).length, 1); assert.equal(f.generations.length, 1);
});

test('optional consumer receives metadata notifications and survives provider stop/start without replay', { timeout: 25000 }, async t => {
  const { f, sessionId } = await make(t, true);
  const observer = f.app.runtime.services.get('continuation-observer')!.value;
  if (!(await observer.snapshot()).optionalSupported) {
    t.skip('Selected frozen host has no ctx.optional; ordinary receive/send and continuation cases still run.'); return;
  }
  await until(async () => (await observer.snapshot()).connected);
  const item = await interruptAfterFirst(f, sessionId);
  await until(async () => {
    const snapshot = await observer.snapshot();
    return snapshot.events.some((event: any) => event.name === 'plugin:qq:connection-changed' && event.data.state === 'online')
      && snapshot.events.some((event: any) => event.name === 'plugin:qq:text-delivery-changed' && event.data.deliveryId === item.deliveryId);
  });
  const events = (await observer.snapshot()).events;
  assert.ok(!JSON.stringify(events).includes('第一句'));
  assert.ok(events.every((event: any) => !('text' in event.data) && !('parts' in event.data)));
  await f.app.runtime.action('qq', 'stop');
  await until(async () => !(await observer.snapshot()).connected);
  assert.equal((await observer.list({ sessionId })).status, 'unavailable');
  assert.equal(f.app.runtime.records.get('continuation-observer')!.status, 'active');
  assert.equal(await f.app.runtime.services.get('witness')!.value.ping(), 'alive');
  await f.app.runtime.action('qq', 'start'); await f.online();
  await until(async () => (await observer.snapshot()).connected);
  const refreshed = await observer.list({ sessionId });
  assert.equal(refreshed.items.length, 1); assert.equal(refreshed.items[0].deliveryId, item.deliveryId);
  assert.equal(sends(f).length, 1);
  const resumed = await observer.resume(key(await itemFor(f, sessionId)));
  assert.equal(resumed.status, 'sent'); assert.equal(resumed.confirmed, true);
  assert.deepEqual(sentText(f), ['第一句。', '第二句。', '第三句。']);
  assert.equal(f.generations.length, 1);
});

test('active-persona host without current-session capability retains interruptions and blocks continuation after reload', { timeout: 20000 }, async t => {
  const { f, sessionId } = await make(t, false, true);
  assert.equal(service(f).textDeliveryResumeSupported, false);
  const item = await interruptAfterFirst(f, sessionId);
  assert.equal(item.canResume, false); assert.equal(item.blockedReason, 'host_blocked');
  const result = await service(f).resumeTextDelivery(key(item), options());
  assert.equal(result.status, 'blocked'); assert.equal(result.reason, 'host_blocked');
  assert.equal(result.confirmed, false); assert.equal(sends(f).length, 1);
  await f.app.runtime.action('qq', 'reload'); await f.online();
  const restored = await itemFor(f, sessionId);
  assert.equal(restored.deliveryId, item.deliveryId); assert.equal(restored.canResume, false);
  assert.equal((await service(f).resumeTextDelivery(key(restored), options())).reason, 'host_blocked');
  assert.equal(sends(f).length, 1); assert.equal(f.generations.length, 1);
  assert.equal(await f.app.runtime.services.get('witness')!.value.ping(), 'alive');
});
