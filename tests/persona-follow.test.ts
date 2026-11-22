/*! Copyright (c) 2026 iinukami and contributors.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { fixture, selectOnWeb, until } from './fixture.ts';
import { temporaryDirectory } from './temporary-directory.ts';

const hostPath = process.env.QQ_PERSONA_HOST_PATH;
const hostBoot = hostPath ? (await import(pathToFileURL(resolve(hostPath, 'core/index.ts')).href)).boot : undefined;
if (hostPath && typeof hostBoot !== 'function') throw Error('Selected QQ persona test host has no boot function');

const markers = { a: 'SYNTHETIC_PERSONA_A', b: 'SYNTHETIC_PERSONA_B' };
async function preparePersonas(root: string) {
  for (const [id, marker] of Object.entries(markers))
    await writeFile(join(root, id + '.md'), marker);
}

test('private QQ always follows the active Web persona and keeps the same history', async t => {
  const f = await fixture(t, {
    hostBoot, temporaryDirectory,
    includeQzone: false,
    prepareHost: preparePersonas,
  });
  await f.online();
  const settings = await (await f.request('/plugins/qq/config')).json();
  assert.equal(Object.hasOwn(settings.config, 'personaId'), false);
  assert.equal(Object.hasOwn(settings, 'personas'), false);
  assert.doesNotMatch(await (await f.request('/plugins/qq/settings')).text(), /id=["']personaId["']/);
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
  assert.deepEqual(Object.keys(await f.app.memory.listSessionMeta()), [sessionId]);
  const history = await f.app.memory.readSession(sessionId);
  assert.deepEqual(history.filter((row: any) => row.role === 'user').map((row: any) => row.text),
    [previous, ...Array.from({ length: seq }, (_, i) => 'Synthetic incoming ' + (i + 1))]);
});

test('an old QQ persona setting is ignored from the first message and on subsequent Web selection', async t => {
  const f = await fixture(t, { hostBoot, temporaryDirectory, includeQzone: false, prepareHost: preparePersonas,
    preparePlugin: async root => {
      const file = join(root, 'data', 'config.json');
      const previous = JSON.parse(await readFile(file, 'utf8'));
      await writeFile(file, JSON.stringify({ ...previous, personaId: 'b' }));
    },
  });
  await f.online();
  assert.equal((await (await f.request('/api/model-config')).json()).activePersona, 'a');
  assert.equal(Object.hasOwn((await (await f.request('/plugins/qq/config')).json()).config, 'personaId'), false);
  const first = f.socket();
  const turn = async (messageId: number) => {
    f.send({ message_id: messageId });
    await until(async () => (await f.status()).recent.some((r: any) => r.messageId === String(messageId) && r.status === 'sent'));
  };
  await turn(1);
  await selectOnWeb(f, 'b');
  await turn(2);
  const sessionId = await f.app.sessions.current();
  const history = await f.app.memory.readSession(sessionId);
  assert.deepEqual(history.filter((r: any) => r.role === 'user').map((r: any) => r.persona_id), ['a', 'b']);
  assert.deepEqual(history.filter((r: any) => r.role === 'assistant').map((r: any) => r.persona_id), ['a', 'b']);
  assert.deepEqual(f.generations.map(g => Object.keys(markers).filter(id =>
    JSON.stringify(g.messages.filter((m: any) => m.role === 'system')).includes(markers[id as keyof typeof markers]))), [['a'], ['b']]);
  assert.deepEqual(Object.keys(await f.app.memory.listSessionMeta()), [sessionId]);
  assert.equal(f.socket(), first);
});

test('Web persona switch during an open QQ turn lets it finish and sends the next message as the new persona', async t => {
  const f = await fixture(t, { hostBoot, temporaryDirectory, includeQzone: false, prepareHost: preparePersonas });
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
