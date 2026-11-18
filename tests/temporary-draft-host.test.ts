/*! Copyright (c) 2026 iinukami and contributors.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { segmentationDefaults } from '../src/config.ts';
import { fixture, until } from './fixture.ts';
import { temporaryDirectory } from './temporary-directory.ts';

const marker = 'SYNTHETIC_TEMP_DRAFT_';
const original = Array.from({ length: 8 }, (_, i) => marker + (i + 1) + '。');
const modelTool = (name: string, args: unknown) => ({
  text: '', toolCalls: [{ id: name, name, arguments: JSON.stringify(args) }],
});

async function installConsumer(root: string) {
  const dir = join(root, 'plugins/draft-consumer');
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'plugin.yaml'),
    'id: draft-consumer\nname: Draft consumer\nversion: 1.0.0\ndescription: Isolated test consumer\noptionalDepends: [qq]\n');
  await writeFile(join(dir, 'index.ts'), `export function apply(ctx) {
    let binding; const events = [];
    ctx.optional('qq', next => { binding = next; });
    for (const name of ['plugin:qq:connection-changed', 'plugin:qq:text-delivery-changed', 'tool/called'])
      ctx.on(name, data => { events.push({ name, data }); });
    ctx.tools.registerTransient({ name: 'draft_fixture_browse', danger: 'safe', description: 'Synthetic material',
      schema: {}, run: () => ({ content: 'synthetic comment', receipt: null }) });
    ctx.provide('draft-consumer', {
      version: () => binding?.service.temporaryDraftApiVersion,
      run: sessionId => ctx.sessions.runTransient({ sessionId, text: 'synthetic wake', permission: 'full' }),
      claim: key => binding.service.claimTemporaryDraft(key),
      release: key => binding.service.releaseTemporaryDraft(key),
      events: () => events,
    });
  }`);
}

async function assertBodyAbsent(root: string) {
  for (const area of ['memory', 'logs', 'plugins/qq/data']) {
    for (const file of await readdir(join(root, area), { recursive: true, withFileTypes: true })) {
      if (file.isFile()) {
        const bytes = await readFile(join(file.parentPath, file.name));
        assert.equal(bytes.includes(marker), false, area + '/' + file.name);
      }
    }
  }
}

test('two of eight temporary parts arrive before disconnection; a consumer can claim only the six unsent parts once', { timeout: 25000 }, async t => {
  const f = await fixture(t, { temporaryDirectory, includeQzone: false, prepareHost: installConsumer,
    config: { permission: 'full', segmentedReply: { ...segmentationDefaults, enabled: true, maxLength: 1000, interval: '0.2,0.2' } } });
  await f.online();
  const consumer = f.app.runtime.services.get('draft-consumer')!.value;
  await until(async () => await consumer.version() === '1.0.0');
  const sessionId = await f.app.sessions.current();
  const connections = f.connects();
  let attempts = 0;
  f.setAction((request, socket) => {
    if (request.action !== 'send_private_msg' || ++attempts !== 2) return false;
    // The success frame precedes the close frame on this WebSocket. The third
    // segment is still in its inter-segment delay when the connection closes.
    socket.send(JSON.stringify({ echo: request.echo, status: 'ok', retcode: 0, data: { message_id: 9202 } }));
    socket.close();
    return true;
  });
  let modelRound = 0, receipt: any;
  f.setGenerate(async input => {
    if (++modelRound === 1) return modelTool('draft_fixture_browse', {});
    if (modelRound === 2) return modelTool('qq_send_message', { userId: '200002', messageId: 'draft-action', text: original.join('') });
    receipt = JSON.parse(input.messages.at(-1).content).result;
    return { text: 'synthetic run complete', toolCalls: [] };
  });
  await consumer.run(sessionId);
  assert.equal(receipt.transient, true);
  assert.equal(receipt.confirmed, false);
  assert.equal(receipt.delivery.totalParts, 8);
  assert.equal(receipt.delivery.sentParts, 2);
  assert.equal(receipt.delivery.notSentParts, 6);
  assert.equal(receipt.delivery.unknownParts, 0);
  assert.ok(!JSON.stringify(receipt).includes(marker));
  assert.equal(typeof receipt.deliveryId, 'string');
  await until(() => f.connects() > connections); await f.online();
  const key = { accountId: '100001', sessionId, deliveryId: receipt.deliveryId };
  for (const wrong of [{ ...key, sessionId: 'unrelated-session' }, { ...key, accountId: '999999' }]) {
    const rejected = await consumer.claim(wrong);
    assert.notEqual(rejected.status, 'claimed'); assert.equal(rejected.parts, undefined);
  }
  await assertBodyAbsent(f.root);
  const results = await Promise.all([consumer.claim(key), consumer.claim(key)]);
  assert.equal(results.filter(r => r.status === 'claimed').length, 1);
  const claimed = results.find(r => r.status === 'claimed');
  assert.deepEqual(claimed.parts.map((p: any) => [p.index, p.text]), original.slice(2).map((text, i) => [i + 3, text]));
  assert.ok(results.filter(r => r.status !== 'claimed').every(r => r.parts === undefined));
  const released = await consumer.release(key);
  assert.equal(released.status, 'released'); assert.ok(!JSON.stringify(released).includes(marker));
  assert.equal((await consumer.claim(key)).parts, undefined);
  await until(async () => (await consumer.events()).some((e: any) => e.name === 'tool/called' && e.data.name === 'qq_send_message'));
  assert.ok(!JSON.stringify(await consumer.events()).includes(marker));
  await delay(450);
  assert.deepEqual(f.calls.filter(r => r.action === 'send_private_msg').map(r => r.params.message[0].data.text), original.slice(0, 2));
  assert.equal(modelRound, 3); assert.equal(f.modelCalls.length, 0);
  await assertBodyAbsent(f.root);
});
