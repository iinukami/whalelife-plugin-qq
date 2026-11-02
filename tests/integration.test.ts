import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import sharp from 'sharp';
import { fixture, until } from './fixture.ts';

test('synced installation loads with no private config, stays offline, and can stop/start independently', { timeout: 20000 }, async t => {
  const f = await fixture(t, { unconfigured: true, packagePath: process.env.QQ_INSTALLED_PACKAGE });
  const current = await (await f.request('/plugins/qq/config')).json();
  assert.equal(current.config.enabled, false); assert.equal(current.config.accountId, '');
  assert.deepEqual(current.config.allowedUsers, []); assert.equal(f.connects(), 0);
  assert.equal(f.app.runtime.records.get('qq')?.status, 'active');
  await f.app.runtime.action('qq', 'stop');
  assert.equal((await f.request('/plugins/qq/settings')).status, 404);
  await f.app.runtime.action('qq', 'start');
  assert.equal((await f.request('/plugins/qq/settings')).status, 200); assert.equal(f.connects(), 0);
  assert.equal(await f.app.runtime.services.get('witness')!.value.ping(), 'alive');
});

test('packaged plugin: authenticated settings, private conversation, source ownership, replay/reload, persona continuity', { timeout: 30000 }, async t => {
  const f = await fixture(t); await f.online();
  assert.equal((await fetch(f.url + '/plugins/qq/settings')).status, 401);
  assert.match(await (await f.request('/plugins/qq/settings')).text(), /QQ 私聊/);
  const config = await (await f.request('/plugins/qq/config')).json();
  assert.ok(!JSON.stringify(config).includes('fake-onebot-secret')); assert.ok(!JSON.stringify(config).includes('fake-model-secret'));
  assert.equal(f.calls[0].authorization, 'Bearer fake-onebot-secret');
  f.send({ persona: 'b', sessionId: 'other', permission: 'full' }); f.send();
  await until(async () => (await f.status()).recent.some((n: any) => n.status === 'sent'));
  assert.equal(f.generations.length, 1); assert.equal(f.calls.filter(c => c.action === 'send_private_msg').length, 1);
  for (const patch of [{ message_type: 'group' }, { sub_type: 'group' }, { post_type: 'message_sent' }, { user_id: 100001 }, { user_id: 200003 }]) f.send({ ...patch, message_id: 99 });
  await new Promise(r => setTimeout(r, 100)); assert.equal(f.generations.length, 1);
  const sessions = async () => Object.entries<any>(await f.app.memory.listSessionMeta()).filter(([, m]) => !m.deleted).map(([id]) => ({ id }));
  const sessionsBefore = await sessions(); assert.equal(sessionsBefore.length, 1);
  const sessionId = sessionsBefore[0].id;
  const rows = await f.app.memory.readSession(sessionId);
  const user = rows.find((x: any) => x.role === 'user');
  assert.equal(user.persona_id, 'a'); assert.equal(user.origin.plugin, 'qq'); assert.match(user.text, /你好🙂/);
  await f.app.runtime.action('qq', 'reload'); await f.online(); f.send();
  await until(async () => (await f.status()).recent.length > 0);
  assert.equal(f.generations.length, 1); assert.equal(f.calls.filter(c => c.action === 'send_private_msg').length, 1);
  assert.equal((await f.save({ personaId: 'b' })).status, 200); await f.online(); f.send({ message_id: 2 });
  await until(() => f.generations.length === 2);
  await until(async () => (await f.status()).recent.some((n: any) => n.status === 'sent'));
  assert.deepEqual((await sessions()).map((s: any) => s.id), [sessionId]);
  assert.ok(f.generations[1].messages.some((m: any) => String(m.content).includes('你好🙂')));
  assert.equal((await f.app.memory.readSession(sessionId)).filter((x: any) => x.role === 'user').at(-1).persona_id, 'b');
});

test('settings reject bad/stale config without killing plugin; v0 migrates without losing credentials', { timeout: 25000 }, async t => {
  const f = await fixture(t, { rawConfig: { schemaVersion: 0, enabled: false, url: 'ws://127.0.0.1:3001/', token: 'OLD-SECRET', selfId: '100001', allowUsers: ['200002'], persona: 'a' } });
  assert.equal((await f.configFile()).schemaVersion, 3); assert.equal((await f.configFile()).accessToken, 'OLD-SECRET');
  assert.ok((await readdir(join(f.root, 'plugins/qq/data'))).includes('config-v0-backup.json'));
  const before = await (await f.request('/plugins/qq/config')).json();
  assert.equal((await f.save({ permission: 'evil' })).status, 400);
  assert.equal((await f.save({ wsUrl: 'wss://different.example/' })).status, 400);
  assert.equal((await f.save({ personaId: 'b' })).status, 200);
  assert.equal((await f.request('/plugins/qq/config', { revision: before.revision, config: before.config })).status, 409);
  assert.equal(f.app.runtime.records.get('qq')?.status, 'active');
  assert.equal(await f.app.runtime.services.get('witness')!.value.ping(), 'alive');
  assert.equal(f.connects(), 0);
});

test('images, animated stickers, emoji, unknown system faces and platform voice enter the full conversation exactly once', { timeout: 30000 }, async t => {
  const f = await fixture(t); await f.online();
  const png = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#ff9900' } }).png().toBuffer();
  const raw = Buffer.alloc(8 * 16 * 3, 100); raw.fill(220, 8 * 8 * 3);
  const gif = await sharp(raw, { raw: { width: 8, height: 16, channels: 3, pageHeight: 8 } }).gif().toBuffer();
  assert.equal((await sharp(gif).metadata()).pages, 2);
  f.send({ message: [
    { type: 'text', data: { text: '看看🙂' } }, { type: 'face', data: { id: 9999 } },
    { type: 'image', data: { url: 'base64://' + png.toString('base64') } },
    { type: 'image', data: { url: 'base64://' + gif.toString('base64') } },
    { type: 'record', data: { file: 'voice-id' } },
  ] });
  await until(() => f.generations.length === 1);
  await until(async () => (await f.status()).recent.some((n: any) => n.status === 'sent'));
  const content = f.generations[0].messages.filter((m: any) => m.role === 'user').at(-1).content;
  for (const expected of ['看看🙂', '比心', '小猫', '明天下午三点见']) assert.ok(content.includes(expected));
  assert.equal(f.modelCalls.length, 2); assert.equal(f.modelCalls[0].authorization, 'Bearer fake-model-secret');
  assert.equal(JSON.parse(f.modelCalls[1].body).messages[0].content.filter((x: any) => x.type === 'image_url').length, 2);
  assert.equal(f.calls.filter(c => c.action === 'fetch_ptt_text').length, 1);
});

test('STT model receives WAV using selected connection; missing vision model fails explicitly and leaves text usable', { timeout: 25000 }, async t => {
  const f = await fixture(t, { config: { speechMode: 'model', visionModelId: '' } }); await f.online();
  const wav = Buffer.alloc(44); wav.write('RIFF'); wav.write('WAVE', 8);
  f.setAction((data, socket) => {
    if (data.action !== 'get_record') return false;
    assert.equal(data.params.out_format, 'wav');
    socket.send(JSON.stringify({ status: 'ok', retcode: 0, echo: data.echo, data: { base64: wav.toString('base64') } })); return true;
  });
  f.send({ message: [{ type: 'record', data: { file: 'voice' } }] });
  await until(() => f.generations.length === 1);
  assert.match(f.modelCalls[0].path, /audio\/transcriptions$/); assert.match(f.modelCalls[0].body, /voice.wav/);
  f.send({ message_id: 2, message: [{ type: 'image', data: { file: 'image' } }] });
  await until(async () => (await f.status()).recent.some((n: any) => n.status === 'failed'));
  assert.equal(f.generations.length, 1);
  f.send({ message_id: 3 }); await until(() => f.generations.length === 2);
  assert.equal(f.app.runtime.records.get('qq')?.status, 'active');
});

test('uncertain delivery never repeats after reconnect/reload, and other plugins remain healthy', { timeout: 25000 }, async t => {
  const f = await fixture(t); await f.online();
  f.setAction((data, socket) => {
    if (data.action !== 'send_private_msg') return false;
    socket.terminate(); return true; // Platform may already have sent it: no acknowledgment.
  });
  f.send();
  await until(async () => (await f.status()).recent.some((n: any) => n.status === 'delivery_failed'));
  await f.online(); f.send();
  await new Promise(r => setTimeout(r, 100));
  assert.equal(f.calls.filter(c => c.action === 'send_private_msg').length, 1); assert.equal(f.generations.length, 1);
  await f.app.runtime.action('qq', 'reload'); await f.online(); f.send();
  await until(async () => (await f.status()).recent.length > 0);
  assert.equal(f.calls.filter(c => c.action === 'send_private_msg').length, 1); assert.equal(f.generations.length, 1);
  assert.equal(await f.app.runtime.services.get('witness')!.value.ping(), 'alive');
  assert.equal(f.app.runtime.records.get('sessions')?.status, 'active');
  const files = await readdir(join(f.root, 'plugins/qq/data'));
  const ledger = JSON.parse(await readFile(join(f.root, 'plugins/qq/data', files.find(x => x.startsWith('delivery-'))!), 'utf8'));
  assert.equal(ledger.parts[0].state, 'pending');
});

test('stop during model generation cancels work, removes pages/services and prevents reconnection', { timeout: 25000 }, async t => {
  const f = await fixture(t); await f.online(); let aborted = false;
  f.setGenerate(input => new Promise((_resolve, reject) => {
    input.signal.addEventListener('abort', () => { aborted = true; reject(Error('cancelled')); }, { once: true });
  }));
  f.send(); await until(() => f.generations.length === 1);
  const connections = f.connects(); await f.app.runtime.action('qq', 'stop');
  assert.ok(aborted); assert.equal((await f.request('/plugins/qq/settings')).status, 404);
  assert.ok(!f.app.runtime.services.has('qq'));
  await new Promise(r => setTimeout(r, 1200));
  assert.equal(f.connects(), connections); assert.equal(f.calls.filter(c => c.action === 'send_private_msg').length, 0);
  assert.equal(await f.app.runtime.services.get('witness')!.value.ping(), 'alive');
  f.setGenerate(undefined); await f.app.runtime.action('qq', 'start'); await f.online();
  f.send(); await until(async () => (await f.status()).recent.length > 0);
  assert.equal(f.generations.length, 1, 'interrupted model/tools are not rerun');
  f.send({ message_id: 2 }); await until(() => f.generations.length === 2);
});

test('stop during media HTTP aborts the request and uncertain preprocessing is not replayed on restart', { timeout: 25000 }, async t => {
  const f = await fixture(t); await f.online(); let entered = false, closed = false;
  f.setModelHandler((_req, res) => { entered = true; res.on('close', () => { closed = true; }); });
  const png = await sharp({ create: { width: 2, height: 2, channels: 3, background: 'red' } }).png().toBuffer();
  const message = [{ type: 'image', data: { url: 'base64://' + png.toString('base64') } }];
  f.send({ message }); await until(() => entered);
  await f.app.runtime.action('qq', 'stop'); await until(() => closed);
  assert.equal(f.generations.length, 0);
  f.setModelHandler(undefined); await f.app.runtime.action('qq', 'start'); await f.online(); f.send({ message });
  await until(async () => (await f.status()).recent.some((n: any) => n.status === 'uncertain'));
  assert.equal(f.modelCalls.length, 0); assert.equal(f.generations.length, 0);
});
