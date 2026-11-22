/*! Copyright (c) 2026 iinukami and contributors.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { fixture, until } from './fixture.ts';
import { temporaryDirectory } from './temporary-directory.ts';

const hostPath = process.env.QQ_PERSONA_HOST_PATH;
const hostBoot = hostPath ? (await import(pathToFileURL(resolve(hostPath, 'core/index.ts')).href)).boot : undefined;
if (hostPath && typeof hostBoot !== 'function') throw Error('Selected QQ persona test host has no boot function');

const markers = { a: 'SYNTHETIC_PERSONA_A', b: 'SYNTHETIC_PERSONA_B' };
async function preparePersonas(root: string) {
  for (const [id, marker] of Object.entries(markers))
    await writeFile(join(root, id + '.md'), marker);
}

async function selectOnWeb(f: Awaited<ReturnType<typeof fixture>>, id: 'a' | 'b') {
  const current = await (await f.request('/api/model-config')).json();
  const saved = await f.request('/api/model-config', {
    revision: current.revision, timezone: current.timezone, activePersona: id,
    models: current.models, providers: current.providers, bindings: current.bindings,
    personaModels: Object.fromEntries(current.personas.map((p: { id: string; model?: string }) => [p.id, p.model || null])),
  });
  const updated = await saved.json();
  assert.equal(saved.status, 200, JSON.stringify(updated));
  assert.equal(updated.activePersona, id);
}

test('private QQ follows the active Web persona by default, supports pinning and keeps the same history', async t => {
  const f = await fixture(t, {
    hostBoot, temporaryDirectory,
    includeQzone: false,
    config: { personaId: undefined }, // Omit this field from a newly configured installation.
    prepareHost: preparePersonas,
  });
  await f.online();
  const qqConfig = async () => (await (await f.request('/plugins/qq/config')).json()).config;
  assert.equal((await qqConfig()).personaId, '');
  const sessionId = await f.app.sessions.create('Synthetic shared conversation');
  assert.equal((await f.request('/api/session/current', { id: sessionId })).status, 200);
  const previous = 'Existing Web conversation marker';
  await f.app.memory.appendEvent({ session: sessionId, type: 'message', role: 'user', text: previous });

  let seq = 0;
  const turn = async (expected: 'a' | 'b') => {
    const id = ++seq;
    const text = 'Synthetic incoming ' + id;
    f.send({ message_id: id, message: [{ type: 'text', data: { text } }] });
    await until(async () => (await f.status()).recent.some((row: any) => row.messageId === String(id) && row.status === 'sent'));
    assert.equal(f.generations.length, id);
    assert.equal(f.calls.filter(c => c.action === 'send_private_msg').length, id);
    const prompt = f.generations.at(-1).messages.filter((m: any) => m.role === 'system');
    assert.ok(JSON.stringify(prompt).includes(markers[expected]), 'model must receive the expected persona instructions');
    assert.ok(!JSON.stringify(prompt).includes(markers[expected === 'a' ? 'b' : 'a']));
    assert.equal(await f.app.sessions.current(), sessionId);
    const history = await f.app.memory.readSession(sessionId);
    const origin = history.filter((row: any) => row.role === 'user' && row.text === text);
    assert.equal(origin.length, 1);
    assert.equal(origin[0].persona_id, expected);
    assert.equal(history.filter((row: any) => row.role === 'assistant').at(-1)?.persona_id, expected);
  };

  // Follow the current selection even on the first incoming message.
  const initialSocket = f.socket();
  await selectOnWeb(f, 'b'); await turn('b');
  await selectOnWeb(f, 'a'); await turn('a');
  await selectOnWeb(f, 'b'); await turn('b');
  assert.equal(f.socket(), initialSocket);
  assert.equal(f.connects(), 1);
  assert.equal((await qqConfig()).personaId, '');

  assert.equal((await f.save({ personaId: 'a' })).status, 200); await f.online();
  await turn('a');
  const pinnedSocket = f.socket();
  await selectOnWeb(f, 'a'); await selectOnWeb(f, 'b'); await turn('a');
  assert.equal(f.socket(), pinnedSocket);
  assert.equal((await qqConfig()).personaId, 'a');

  assert.equal((await f.save({ personaId: '' })).status, 200); await f.online();
  await turn('b');
  const followingSocket = f.socket();
  await selectOnWeb(f, 'a'); await turn('a');
  assert.equal(f.socket(), followingSocket);
  assert.deepEqual(Object.keys(await f.app.memory.listSessionMeta()), [sessionId]);
  const history = await f.app.memory.readSession(sessionId);
  assert.deepEqual(history.filter((row: any) => row.role === 'user').map((row: any) => row.text),
    [previous, ...Array.from({ length: seq }, (_, i) => 'Synthetic incoming ' + (i + 1))]);
});

test('private QQ preserves an existing explicit persona when Web selects another', async t => {
  const f = await fixture(t, { hostBoot, temporaryDirectory, includeQzone: false, config: { personaId: 'b' },
    prepareHost: root => writeFile(join(root, 'b.md'), 'PREVIOUSLY_PINNED_PERSONA') });
  await f.online();
  assert.equal((await (await f.request('/api/model-config')).json()).activePersona, 'a');
  f.send({ message_id: 1 });
  await until(async () => (await f.status()).recent.some((row: any) => row.messageId === '1' && row.status === 'sent'));
  assert.ok(JSON.stringify(f.generations[0].messages.filter((m: any) => m.role === 'system')).includes('PREVIOUSLY_PINNED_PERSONA'));
  const history = await f.app.memory.readSession(await f.app.sessions.current());
  assert.equal(history.find((row: any) => row.role === 'user')?.persona_id, 'b');
  assert.equal((await f.configFile()).personaId, 'b');
});

test('Web persona switch during an open QQ turn lets it finish and sends the next message as the new persona', async t => {
  const f = await fixture(t, { hostBoot, temporaryDirectory, includeQzone: false, config: { personaId: undefined }, prepareHost: preparePersonas });
  await f.online();
  const sessionId = await f.app.sessions.current();
  const socket = f.socket();
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  f.setGenerate(async input => {
    const instructions = JSON.stringify(input.messages.filter((m: any) => m.role === 'system'));
    const persona = Object.entries(markers).filter(([, marker]) => instructions.includes(marker));
    assert.equal(persona.length, 1);
    if (f.generations.length === 1) await held;
    return { text: 'Reply from ' + persona[0][0], toolCalls: [] };
  });
  const deliver = (id: number, text: string) =>
    f.send({ message_id: id, message: [{ type: 'text', data: { text } }] });
  try {
    deliver(901, 'Before selection change');
    await until(() => f.generations.length === 1);
    await selectOnWeb(f, 'b');
    deliver(902, 'After selection change');
    // Wait for the receiver to decide what to do with the second message before releasing the first reply.
    await until(async () => (await f.status()).recent.some((r: any) => r.messageId === '902'));
    assert.equal(f.calls.filter(c => c.action === 'send_private_msg').length, 0);
  } finally {
    release();
  }
  await until(async () => (await f.status()).queued === 0);
  const sent = f.calls.filter(c => c.action === 'send_private_msg').map(c => c.params.message[0].data.text);
  assert.deepEqual(sent, ['Reply from a', 'Reply from b']);
  assert.equal(f.generations.length, 2);
  const history = await f.app.memory.readSession(sessionId);
  const conversation = history.filter((r: any) => ['user', 'assistant'].includes(r.role));
  assert.deepEqual(conversation.map((r: any) => [r.text, r.persona_id]), [
    ['Before selection change', 'a'], ['Reply from a', 'a'],
    ['After selection change', 'b'], ['Reply from b', 'b'],
  ]);
  assert.deepEqual(Object.keys(await f.app.memory.listSessionMeta()), [sessionId]);
  assert.equal(f.socket(), socket);
});
