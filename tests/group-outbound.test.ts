/*! Copyright (c) 2026 iinukami and contributors.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import sharp from 'sharp';
import type { Context } from 'whalelife';
import { parseConfig, QQError } from '../src/config.ts';
import { GroupOutbound, type GroupSegment, type GroupTextInput } from '../src/group-outbound.ts';

const groupId = '200002', member = '300003', bot = '100001';
const signal = new AbortController().signal;
function fixture() {
  const files = new Map<string, unknown>(), calls: Array<{ groupId: string; message: GroupSegment[] }> = [];
  const ctx = { config: {
    read: (name: string) => structuredClone(files.get(name) ?? {}),
    save: (name: string, value: unknown) => files.set(name, structuredClone(value)),
  } } as unknown as Context;
  const state = { allowed: true, result: '90001', revokeOnSubmit: false };
  const make = () => new GroupOutbound(ctx, parseConfig({ accountId: bot }), {
    authorize: (group: string) => {
      if (!state.allowed || group !== groupId) throw new QQError('group', '当前群未获授权。', true);
    },
    canQuote: (group, messageId) => group === groupId && messageId === '-882',
    submit: async (groupId, message, _signal, mark) => {
      if (state.revokeOnSubmit) state.allowed = false;
      await mark();
      calls.push({ groupId, message });
      if (state.result === 'timeout') throw new QQError('timeout', '模拟协议超时。');
      return state.result;
    },
  });
  return { group: make(), make, files, calls, state };
}

test('group text uses the target group with one quote, distinct mentions and literal text', async () => {
  const f = fixture(), literal = 'hello [CQ:at,qq=all]';
  const result = await f.group.sendText({ groupId, text: literal, atUserIds: [member, member], replyTo: '-882' }, signal);
  assert.equal(result.confirmed, true); assert.equal(result.messageId, '90001');
  assert.deepEqual(f.calls, [{ groupId, message: [
    { type: 'reply', data: { id: '-882' } }, { type: 'at', data: { qq: member } }, { type: 'text', data: { text: literal } },
  ] }]);
  assert.equal(f.files.size, 0);
});

test('blocked group, foreign quote, invalid mentions and revoked authorization make no submission', async () => {
  const f = fixture(), base = { groupId, text: 'hello' };
  for (const bad of [{ groupId: '400004' }, { replyTo: '100' }, { replyTo: '0' }, { atUserIds: ['all'] },
    { atUserIds: [bot] }, { atUserIds: [member,member,member,member] }, { text: ' ' }, { text: 'x'.repeat(4001) }]) {
    await assert.rejects(f.group.sendText({ ...base, ...bad }, signal));
  }
  f.state.revokeOnSubmit = true;
  await assert.rejects(f.group.sendText({ ...base, actionId: 'revoked' }, signal));
  assert.equal(f.calls.length, 0);
});

test('a stable group action survives concurrent sends and reload without storing content', async () => {
  const f = fixture();
  const input = { groupId, actionId: 'stable', text: 'synthetic group text not to be stored' };
  const [a,b] = await Promise.all([f.group.sendText(input, signal), f.group.sendText(input, signal)]);
  assert.equal(a.messageId, b.messageId); assert.equal(f.calls.length, 1);
  assert.equal((await f.make().sendText(input, signal)).duplicate, true);
  await assert.rejects(f.make().sendText({ ...input, text: 'different' }, signal), /内容不同/);
  assert.equal(f.calls.length, 1);
  assert.ok(!JSON.stringify([...f.files.values()]).includes(input.text));
});

for (const result of ['timeout', '0', 'invalid']) test('legacy text rejects an unconfirmed result: ' + result, async () => {
  const f = fixture(); f.state.result = result;
  const input: GroupTextInput = { groupId, text: 'synthetic', actionId: 'unknown' };
  await assert.rejects(f.group.sendText(input, signal), /不确定/);
  assert.equal(f.calls.length, 1);
  f.state.result = '908';
  await assert.rejects(f.make().sendText(input, signal), /不确定/);
  assert.equal(f.calls.length, 1);
});

function wav() {
  const raw = Buffer.alloc(48); raw.write('RIFF'); raw.writeUInt32LE(40,4); raw.write('WAVEfmt ',8);
  raw.writeUInt32LE(16,16); raw.writeUInt16LE(1,20); raw.writeUInt16LE(1,22); raw.writeUInt32LE(16000,24);
  raw.writeUInt32LE(32000,28); raw.writeUInt16LE(2,32); raw.writeUInt16LE(16,34); raw.write('data',36); raw.writeUInt32LE(4,40);
  return raw.toString('base64');
}
test('community media and voice payloads share confirmations and preserve the single platform message', async () => {
  const f = fixture();
  const base64 = (await sharp({ create: { width: 2, height: 2, channels: 3, background: '#ff0000' } }).png().toBuffer()).toString('base64');
  const picture = { type: 'image' as const, mime: 'image/png', base64, asMeme: false };
  const voice = { type: 'voice' as const, mime: 'audio/wav', base64: wav() };
  const imageResult = await f.group.sendMedia({ groupId, parts: [{ type:'text', text:'caption' }, picture] }, signal);
  assert.equal(imageResult.confirmed, true); assert.deepEqual(f.calls[0].message, [
    { type:'text', data:{ text:'caption' } }, { type:'image', data:{ file:'base64://' + base64, sub_type:0 } },
  ]);
  f.state.result = 'timeout';
  const audio = { groupId, parts:[voice], actionId: 'group-record' };
  const result = await f.group.sendMedia(audio, signal);
  assert.equal(result.status, 'uncertain'); assert.equal(result.retryAutomatically, false);
  assert.deepEqual(f.calls[1].message, [{ type:'record', data:{ file:'base64://' + voice.base64 } }]);
  assert.equal((await f.make().sendMedia(audio, signal)).status, 'uncertain');
  for (const parts of [[voice,picture], [{ ...voice, base64 }], [{ ...picture, base64:voice.base64 }]]) {
    assert.equal((await f.group.sendMedia({ groupId, parts }, signal)).status, 'not_submitted');
  }
  assert.equal(f.calls.length, 2);
  assert.ok(!JSON.stringify([...f.files.values()]).includes(voice.base64));
});
