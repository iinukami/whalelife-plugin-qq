/*! Copyright (c) 2026 iinukami and contributors.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fixture } from './fixture.ts';
import { temporaryDirectory } from './temporary-directory.ts';

// One second of mono 16-bit PCM at 16 kHz.
function wavFile() {
  const samples = 16000;
  const out = Buffer.alloc(44 + samples * 2);
  out.write('RIFF'); out.writeUInt32LE(out.length - 8, 4); out.write('WAVEfmt ', 8);
  out.writeUInt32LE(16, 16); out.writeUInt16LE(1, 20); out.writeUInt16LE(1, 22);
  out.writeUInt32LE(samples, 24); out.writeUInt32LE(samples * 2, 28);
  out.writeUInt16LE(2, 32); out.writeUInt16LE(16, 34);
  out.write('data', 36); out.writeUInt32LE(samples * 2, 40);
  for (let i = 0; i < samples; i++) out.writeInt16LE(i % 80 < 40 ? 120 : -120, 44 + 2 * i);
  return out;
}

test('private voice service preserves one record and blocks uncertain replays and unauthorized recipients', async t => {
  const f = await fixture(t, { temporaryDirectory, includeQzone: false, config: { permission: 'full' } });
  await f.online();
  const sessionId = await f.app.sessions.create('synthetic private voice');
  const audio = wavFile(), base64 = audio.toString('base64');
  const key = { userId: '200002', sessionId, actionId: 'synthetic-voice' };
  const payload = { ...key, parts: [{ type: 'voice', id: createHash('sha256').update(audio).digest('hex'), mime: 'audio/wav', base64 }] };
  const qq = () => f.app.runtime.services.get('qq')!.value;
  const sends = () => f.calls.filter(c => c.action === 'send_private_msg');
  const sent = await qq().sendMedia(payload);
  assert.equal(sent.status, 'sent'); assert.equal(sent.confirmed, true);
  assert.equal(sent.parts[0].type, 'voice'); assert.equal(sent.parts[0].messageId, '9000');
  assert.equal(sends().length, 1);
  assert.equal(sends()[0].params.message.length, 1);
  assert.equal(sends()[0].params.message[0].type, 'record');
  assert.ok(sends()[0].params.message[0].data.file === 'base64://' + base64);
  assert.equal((await qq().sendMedia(payload)).duplicate, true);
  assert.equal((await qq().mediaDelivery(key)).status, 'sent');
  const data = join(f.root, 'plugins/qq/data');
  const ledgers = (await readdir(data)).filter(name => name.startsWith('media-delivery-'));
  assert.equal(ledgers.length, 1);
  assert.ok(!(await readFile(join(data, ledgers[0]), 'utf8')).includes(base64));
  await assert.rejects(qq().sendMedia({ ...payload, userId: '200003' }));
  assert.equal(sends().length, 1);

  const uncertain = { ...payload, actionId: 'synthetic-no-receipt' };
  f.setAction(req => req.action === 'send_private_msg'); // Accept submission but suppress the platform ACK.
  assert.equal((await qq().sendMedia(uncertain)).status, 'uncertain');
  await f.app.runtime.action('qq', 'reload'); await f.online();
  assert.equal((await qq().sendMedia(uncertain, { retry: true })).status, 'uncertain');
  assert.equal(sends().length, 2);
});

// Opt in with a local copy of the community package. Only executable source and manifests
// are copied; its model files, settings, generated audio and real accounts stay outside the fixture.
const voicePackage = process.env.WHALELIFE_TEST_VOICE_PACKAGE;
test('unmodified community qq_say synthesizes and delivers through the public QQ service', {
  skip: !voicePackage && 'set WHALELIFE_TEST_VOICE_PACKAGE to the community voice plugin directory',
}, async t => {
  const f = await fixture(t, { temporaryDirectory, includeQzone: false, config: { permission: 'full' },
    prepareHost: async root => {
      const dir = join(root, 'plugins/voice');
      for (const name of ['plugin.yaml', 'index.ts', 'shared.ts', 'sub/speak/plugin.yaml', 'sub/speak/index.ts',
        'sub/sing/plugin.yaml', 'sub/sing/index.ts']) {
        const dest = join(dir, name);
        await mkdir(dirname(dest), { recursive: true });
        await copyFile(join(voicePackage!, name), dest);
      }
      // Use the fixture's own loopback model provider. The cloud backend never boots a local TTS process.
      await mkdir(join(dir, 'data'));
      await writeFile(join(dir, 'data/config.json'), JSON.stringify({ engine: 'cloud', modelId: 'synthetic-tts', cloudVoice: 'fixture', play: false }));
      const config = join(root, 'config/config.json');
      const main = JSON.parse(await readFile(config, 'utf8'));
      main.models.push({ id: 'synthetic-tts', name: 'Fixture TTS', provider: 'test', model: 'synthetic-tts', type: 'tts', enabled: true });
      await writeFile(config, JSON.stringify(main));
    } });
  await f.online();
  const wav = wavFile(), requests: unknown[] = [];
  f.setModelHandler(async (req, res) => {
    if (req.url !== '/v1/audio/speech' || req.method !== 'POST') { res.writeHead(404).end(); return; }
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk);
    requests.push(JSON.parse(Buffer.concat(chunks).toString()));
    res.writeHead(200, { 'content-type': 'audio/wav' }).end(wav);
  });
  const id = await f.app.sessions.create('synthetic conversation for qq_say');
  const input = { userId: '200002', actionId: 'fixture-qq-say', text: 'Synthetic voice sample.' };
  const call = await f.app.tools.call('qq_say', input, { id, personaId: 'a', permission: 'full' });
  assert.equal(call.ok, true, String(call.error));
  assert.equal(call.result.status, 'sent', call.result.error);
  assert.equal(call.result.confirmed, true); assert.equal(call.result.parts[0].messageId, '9000');
  assert.deepEqual(requests, [{ input: input.text, model: 'synthetic-tts', voice: 'fixture', response_format: 'wav' }]);
  const sends = f.calls.filter(c => c.action === 'send_private_msg');
  assert.equal(sends.length, 1); assert.equal(String(sends[0].params.user_id), input.userId);
  assert.equal(sends[0].params.message.length, 1); assert.equal(sends[0].params.message[0].type, 'record');
  assert.ok(sends[0].params.message[0].data.file === 'base64://' + wav.toString('base64'));
  const dir = join(f.root, 'plugins/voice/sub/speak/data/wav');
  const names = await readdir(dir);
  assert.equal(names.length, 1);
  assert.deepEqual(await readFile(join(dir, names[0])), wav);
});
