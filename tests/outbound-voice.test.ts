/*! Copyright (c) 2026 iinukami and contributors.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Context } from 'whalelife';
import { parseConfig, QQError } from '../src/config.ts';
import { OutboundMedia, type MediaAction } from '../src/outbound-media.ts';

const key = { userId: '200002', sessionId: 'voice-test', actionId: 'speak-once' };
const signal = new AbortController().signal;

function pcmWav() {
  // 100 ms of mono 16-bit 16 kHz PCM. No codec, file or network dependency.
  const samples = 3200;
  const wav = Buffer.alloc(44 + samples);
  wav.write('RIFF');
  wav.writeUInt32LE(wav.length - 8, 4);
  wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(16000, 24);
  wav.writeUInt32LE(32000, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write('data', 36);
  wav.writeUInt32LE(samples, 40);
  return wav;
}

function voice(bytes = pcmWav()) {
  return { type: 'voice' as const, id: createHash('sha256').update(bytes).digest('hex'), mime: 'audio/wav' as const,
    base64: bytes.toString('base64') };
}

function fixture(options: { afterPending?: QQError; permission?: 'off' | 'full'; maxMediaBytes?: number } = {}) {
  const records = new Map<string, unknown>();
  const experiences: unknown[] = [];
  const frames: unknown[][] = [];
  const ctx = {
    config: {
      read: async (file: string) => structuredClone(records.get(file) ?? {}),
      save: async (file: string, value: unknown) => { records.set(file, structuredClone(value)); },
    },
    sessions: { context: async () => ({}) },
    memory: { recordExperience: async (_sessionId: string, event: unknown) => { experiences.push(event); } },
  } as unknown as Context;
  const config = parseConfig({ accountId: '100001', allowedUsers: [key.userId],
    permission: options.permission ?? 'full', maxMediaBytes: options.maxMediaBytes ?? 8192 });
  const open = () => new OutboundMedia(ctx, config, async (userId, message, _delay, _signal, markPending) => {
    assert.equal(userId, key.userId);
    await markPending();
    frames.push(message);
    if (options.afterPending) throw options.afterPending;
    return '7101';
  });
  return { open, records, experiences, frames };
}

test('a standalone WAV is sent as one native record, confirmed once and not persisted as audio', async () => {
  const f = fixture(), media = f.open(), part = voice();
  const input = { ...key, parts: [part] };
  const receipt = await media.execute(input, signal);
  assert.equal(receipt.confirmed, true);
  assert.equal(receipt.status, 'sent');
  assert.equal(receipt.parts.length, 1);
  assert.equal(receipt.parts[0].type, 'voice');
  assert.equal(receipt.parts[0].messageId, '7101');
  assert.equal(f.frames.length, 1);
  assert.equal(f.frames[0].length, 1);
  assert.partialDeepStrictEqual(f.frames[0][0], { type: 'record', data: { file: 'base64://' + part.base64 } });
  const reopened = f.open();
  assert.equal((await reopened.status(key)).status, 'sent');
  assert.equal((await reopened.execute(input, signal, true)).duplicate, true);
  const changed = pcmWav(); changed.writeInt16LE(22, 44);
  await assert.rejects(reopened.execute({ ...key, parts: [voice(changed)] }, signal));
  assert.equal(f.frames.length, 1);
  assert.equal(JSON.stringify([[...f.records.values()], f.experiences, receipt]).includes(part.base64), false);
});

for (const code of ['timeout', 'invalid_id', 'platform_failed']) test(`a submitted voice with ${code} stays uncertain across reopening and explicit retry`, async () => {
  const f = fixture({ afterPending: new QQError(code, 'No evidence of non-delivery') }), input = { ...key, parts: [voice()] };
  const first = await f.open().execute(input, signal);
  assert.equal(first.status, 'uncertain');
  assert.equal(first.confirmed, false);
  const reopened = f.open();
  assert.partialDeepStrictEqual(await reopened.status(key), { status: 'uncertain', canRetry: false });
  assert.equal((await reopened.execute(input, signal, true)).status, 'uncertain');
  assert.equal(f.frames.length, 1);
});

test('invalid voice data and mixed or repeated voice parts are rejected before submission', async () => {
  const f = fixture(), media = f.open(), part = voice();
  const truncated = pcmWav(); truncated.writeUInt32LE(truncated.length, 40);
  const cases: [string, MediaAction['parts']][] = [
    ['not WAV', [voice(Buffer.from('not RIFF/WAVE'))]],
    ['out-of-bounds data chunk', [voice(truncated)]],
    ['mismatched hash', [{ ...part, id: '0'.repeat(64) }]],
    ['malformed base64', [{ ...part, base64: '@' + part.base64.slice(1) }]],
    ['voice with text', [part, { type: 'text', text: 'caption' }]],
    ['two voice parts', [part, part]],
  ];
  for (const [label, parts] of cases) await assert.rejects(media.execute({ ...key, parts }, signal), label);
  assert.equal(f.frames.length, 0);
  assert.equal(f.records.size, 0);
});

test('voice honors QQ permission, recipient whitelist and configured media size', async () => {
  const input = { ...key, parts: [voice()] };
  for (const [f, userId] of [
    [fixture({ permission: 'off' }), key.userId], [fixture(), '300003'], [fixture({ maxMediaBytes: 1024 }), key.userId],
  ] as const) {
    await assert.rejects(f.open().execute({ ...input, userId }, signal));
    assert.equal(f.frames.length, 0);
  }
});
