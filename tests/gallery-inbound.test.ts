import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { baselineBoot, positiveBaselines } from './host-baseline.ts';
import sharp from 'sharp';
import { fixture, until } from './fixture.ts';
import { InboundMedia } from '../src/inbound-media.ts';

type Fixture = Awaited<ReturnType<typeof fixture>>;
const sent = (f: Fixture, id = '1') => until(async () => (await f.status()).recent.some((n: any) => n.messageId === id && n.status === 'sent'));
const content = (f: Fixture, index = 0): string => f.generations[index].messages.filter((m: any) => m.role === 'user').at(-1).content;
const refs = (text: string) => [...text.matchAll(/mediaRef=([a-zA-Z0-9_-]+)/g)].map(m => m[1]);
const imageEvent = (bytes: Buffer) => ({ message: [{ type: 'image', data: { url: 'base64://' + bytes.toString('base64') } }] });
const png = () => sharp({ create: { width: 8, height: 8, channels: 3, background: '#ffaa33' } }).png().toBuffer();
async function gif() {
  const raw = Buffer.alloc(8 * 16 * 3, 100); raw.fill(220, 8 * 8 * 3);
  return sharp(raw, { raw: { width: 8, height: 16, channels: 3, pageHeight: 8 } }).gif().toBuffer();
}
async function realGallery(root: string) {
  await cp(new URL('../../whalelife-plugin-gallery/dist/gallery', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'), join(root, 'plugins/gallery'), { recursive: true });
  await mkdir(join(root, 'plugins/gallery/data'), { recursive: true });
  await writeFile(join(root, 'plugins/gallery/data/config.json'), JSON.stringify({ schemaVersion: 1, visionModelId: 'vision', embeddingModelId: 'embedding', topK: 5, allowOriginals: false }));
  const path = join(root, 'config/config.json'), config = JSON.parse(await readFile(path, 'utf8'));
  config.models.push({ id: 'embedding', name: 'Embedding', provider: 'test', model: 'embedding', type: 'embedding', enabled: true, dimensions: 2 });
  await writeFile(path, JSON.stringify(config));
}
function galleryModels(f: Fixture) {
  f.setModelHandler(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const input = JSON.parse(raw);
    f.modelCalls.push({ path: req.url, body: raw });
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(req.url?.endsWith('/embeddings') ? { data: [{ embedding: [1, 0] }], usage: { total_tokens: 4 } }
      : { choices: [{ message: { content: input.messages?.some((message: any) => message.role === 'system' && typeof message.content === 'string' && message.content.includes('只输出 JSON 对象')) ? JSON.stringify({ description: '小猫挥手', tags: ['猫'], purposes: ['meme'] }) : '小猫挥手。' } }], usage: { total_tokens: 8 } }));
  });
}
async function fakeGallery(root: string) {
  const dir = join(root, 'plugins/gallery'); await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'plugin.yaml'), 'id: gallery\nname: Synthetic gallery\nversion: 1.0.0\ndescription: Test only\n');
  await writeFile(join(dir, 'index.ts'), `export function apply(ctx) {
    let mode = 'ok', offers = [], cancelled = 0;
    ctx.provide('gallery', { mode: value => { mode = value; }, state: () => ({ offers, cancelled }),
      async offerMedia(input, {signal}) {
        offers.push(input);
        if (mode === 'fail') throw Error('secret-test-credential');
        if (mode === 'wait') {
          await new Promise(resolve => signal.addEventListener('abort', resolve, {once:true})); cancelled++;
        }
        signal.throwIfAborted();
        return { mediaRef: 'test-ref-' + offers.length, expiresInSeconds: 86400 };
      }
    });
  }`);
}

for (const baseline of positiveBaselines) test(`QQ → real gallery on ${baseline}: original GIF/multiple images, model collection, scoped refs and reload deduplication`, { timeout: 45000 }, async t => {
  const hostBoot = await baselineBoot(baseline);
  const f = await fixture(t, { hostBoot, config: { permission: 'full' }, prepareHost: realGallery });
  galleryModels(f); await f.online();
  await until(async () => (await f.status()).mediaBridge.active);
  assert.equal((await f.status()).mediaBridge.mode, 'builtin');
  assert.equal(f.app.runtime.records.has('qq/gallery'), false);
  const a = await png(), b = await gif(); assert.equal((await sharp(b).metadata()).pages, 2);
  let collected: any, turn = 0;
  f.setGenerate(async input => {
    if (turn++ === 0) {
      const found = refs(input.messages.filter((m: any) => m.role === 'user').at(-1).content);
      assert.equal(found.length, 2); assert.notEqual(found[0], found[1]);
      return { text: '', toolCalls: [{ id: 'collect-gif', name: 'gallery_collect', arguments: JSON.stringify({ mediaRef: found[1] }) }] };
    }
    collected = JSON.parse(input.messages.at(-1).content).result;
    // Reentrant QQ sending must not deadlock behind incoming route preparation.
    if (turn === 2) {
      assert.equal(collected.state, 'saved');
      return { text: '', toolCalls: [{ id: 'same-round-send', name: 'qq_send_message', arguments: JSON.stringify({ userId: '200002', messageId: 'same-round', text: '已保存原图。' }) }] };
    }
    assert.equal(collected.status, 'sent');
    return { text: '完成。', toolCalls: [] };
  });
  f.send({ message: [...imageEvent(a).message, { type: 'mface', data: { url: 'base64://' + b.toString('base64') } }] });
  await sent(f);
  const found = refs(content(f)), inputRow = (Object.entries<any>(await f.app.memory.listSessionMeta())).find(([, m]) => !m.deleted)!;
  const sessionId = inputRow[0];
  const gallery = f.app.runtime.services.get('gallery')!.value;
  const state = async () => (await f.request('/plugins/gallery/state')).json();
  await until(async () => (await state()).jobs[0]?.state === 'completed');
  assert.equal((await state()).config.allowOriginals, false);
  const items = (await state()).items;
  assert.equal(items.length, 1, 'offering the first image does not collect it');
  const media = await gallery.readMedia(items[0].id);
  assert.equal(media.mime, 'image/gif'); assert.deepEqual(Buffer.from(media.base64, 'base64'), b);
  const other = await f.app.sessions.create('other');
  const rejected = await f.app.tools.call('gallery_collect', { mediaRef: found[0] }, { id: other, permission: 'full' });
  assert.equal(rejected.result.ok, false); assert.equal(rejected.result.code, 'media_ref');
  const collectedPng = await f.app.tools.call('gallery_collect', { mediaRef: found[0] }, { id: sessionId, permission: 'full' });
  assert.equal(collectedPng.result.state, 'saved');
  assert.deepEqual(Buffer.from((await gallery.readMedia(collectedPng.result.asset.id)).base64, 'base64'), a);
  await until(async () => (await state()).jobs.every((job: any) => job.state === 'completed'));
  assert.ok(!content(f).includes(a.toString('base64')) && !content(f).includes('base64://'));
  const before = { generations: f.generations.length, modelCalls: f.modelCalls.length, sends: f.calls.filter(c => c.action === 'send_private_msg').length };
  await f.app.runtime.action('qq', 'reload'); await f.online();
  f.send({ message: [...imageEvent(a).message, { type: 'mface', data: { url: 'base64://' + b.toString('base64') } }] }); await sent(f);
  assert.equal(f.generations.length, before.generations); assert.equal(f.calls.filter(c => c.action === 'send_private_msg').length, before.sends);
  assert.equal(f.modelCalls.length, before.modelCalls);
  assert.equal(refs(content(f)).length, 2);
  await f.app.runtime.action('gallery', 'stop');
  assert.equal(f.app.runtime.records.get('qq')?.status, 'active');
  await until(async () => !(await f.status()).mediaBridge.active);
  f.setGenerate(undefined); f.send({ message_id: 2, ...imageEvent(a) }); await sent(f, '2');
  assert.deepEqual(refs(content(f, before.generations)), []);
  await f.app.runtime.action('gallery', 'start');
  await until(async () => (await f.status()).mediaBridge.active);
  assert.equal(await f.app.runtime.services.get('witness')!.value.ping(), 'alive');
});

test('QQ without gallery retains image/voice/text behavior and does not expose raw bytes', async t => {
  const f = await fixture(t); await f.online();
  assert.equal((await f.status()).mediaBridge.active, false);
  assert.equal(f.app.runtime.records.get('qq')?.status, 'active');
  assert.equal(f.app.runtime.records.has('qq/gallery'), false);
  const bytes = await png(); f.send(imageEvent(bytes)); await sent(f);
  assert.match(content(f), /小猫/); assert.deepEqual(refs(content(f)), []);
  assert.ok(!content(f).includes(bytes.toString('base64')));
});

test('Web switch during recognition and direct/background binding cannot move the image reference to another session', async t => {
  const f = await fixture(t, { prepareHost: fakeGallery }); await f.online();
  const a = await f.app.sessions.current(), b = await f.app.sessions.create('B');
  let release!: () => void, entered = false;
  const gate = new Promise<void>(r => release = r); t.after(release);
  f.setModelHandler(async (req, res) => { for await (const _ of req) {} entered = true; await gate; res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ choices: [{ message: { content: 'held-image' } }] })); });
  f.send(imageEvent(await png())); await until(() => entered);
  await f.request('/api/session/current', { id: b });
  await assert.rejects(f.app.runtime.services.get('qq')!.value.sendText({ userId: '200002', messageId: 'during-image', text: 'must-not-send' }));
  await new Promise(r => setTimeout(r, 1200)); release(); await sent(f);
  const offered = (await f.app.runtime.services.get('gallery')!.value.state()).offers[0];
  assert.equal(offered.sessionId, a); assert.equal(offered.source, 'qq');
  assert.ok((await f.app.memory.readSession(a)).some((row: any) => row.role === 'user' && row.text.includes('mediaRef=test-ref-1')));
  assert.equal((await f.app.memory.readSession(b)).length, 0);
  f.send({ message_id: 2 }); await sent(f, '2');
  assert.ok((await f.app.memory.readSession(b)).some((row: any) => row.role === 'user'));
});

test('without a media receiver, session selection still follows Web after recognition as before', async t => {
  const f = await fixture(t); await f.online();
  const a = await f.app.sessions.current(), b = await f.app.sessions.create('B');
  let release!: () => void, entered = false;
  const gate = new Promise<void>(r => release = r); t.after(release);
  f.setModelHandler(async (req, res) => { for await (const _ of req) {} entered = true; await gate; res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ choices: [{ message: { content: 'old-selection-timing' } }] })); });
  f.send(imageEvent(await png())); await until(() => entered);
  await f.request('/api/session/current', { id: b }); release(); await sent(f);
  assert.equal((await f.app.memory.readSession(a)).length, 0);
  assert.ok((await f.app.memory.readSession(b)).some((row: any) => row.role === 'user' && row.text.includes('old-selection-timing')));
  assert.equal(refs(content(f)).length, 0);
});

test('QQ gallery switch cancels an in-flight offer, failure never claims collection, resume only handles new messages', async t => {
  const f = await fixture(t, { prepareHost: fakeGallery }); await f.online();
  const gallery = f.app.runtime.services.get('gallery')!.value;
  await gallery.mode('wait'); f.send(imageEvent(await png()));
  await until(async () => (await gallery.state()).offers.length === 1);
  assert.equal((await f.save({ galleryEnabled: false })).status, 200); await sent(f);
  await until(async () => (await gallery.state()).cancelled === 1);
  assert.equal((await f.status()).mediaBridge.active, false);
  assert.match(content(f), /未取得可用/); assert.deepEqual(refs(content(f)), []);
  f.send({ message_id: 2 }); await sent(f, '2');
  await gallery.mode('fail'); assert.equal((await f.save({ galleryEnabled: true })).status, 200);
  await until(async () => (await f.status()).mediaBridge.active);
  f.send({ message_id: 3, ...imageEvent(await png()) }); await sent(f, '3');
  assert.match(content(f, 2), /未取得可用/); assert.ok(!content(f, 2).includes('secret-test-credential'));
  assert.equal(f.app.runtime.records.get('qq')?.status, 'active');
  assert.equal(f.app.runtime.records.has('qq/gallery'), false);
  await gallery.mode('ok'); f.send({ message_id: 4, ...imageEvent(await png()) }); await sent(f, '4');
  assert.equal(refs(content(f, 3)).length, 1);
  f.send({ message_id: 3, ...imageEvent(await png()) }); await until(async () => (await f.status()).recent[0]?.messageId === '3');
  assert.equal(f.generations.length, 4); assert.equal((await gallery.state()).offers.length, 3);
});

test('parent stop cancels handoff and prevents model/send replay after reload', async t => {
  const f = await fixture(t, { prepareHost: fakeGallery }); await f.online();
  const gallery = f.app.runtime.services.get('gallery')!.value;
  await gallery.mode('wait'); const event = imageEvent(await png()); f.send(event);
  await until(async () => (await gallery.state()).offers.length === 1);
  await f.app.runtime.action('qq', 'stop');
  await until(async () => (await gallery.state()).cancelled === 1);
  assert.equal(f.generations.length, 0); assert.equal(f.calls.filter(c => c.action === 'send_private_msg').length, 0);
  await gallery.mode('ok'); await f.app.runtime.action('qq', 'start'); await f.online();
  f.send(event); await until(async () => (await f.status()).recent[0]?.status === 'uncertain');
  assert.equal((await gallery.state()).offers.length, 1); assert.equal(f.generations.length, 0);
  f.send({ message_id: 2 }); await sent(f, '2');
});

test('receiver unregister cancels ignored work, rejects malformed references and releases old registrations', async () => {
  const media = new InboundMedia(), owner = new AbortController(), request = new AbortController();
  const input = { sessionId: 'a', messageId: '1', imageIndex: 0, mime: 'image/png', base64: '' };
  let called = false;
  const dispose = media.register(async () => { called = true; return new Promise(() => {}); }, { signal: owner.signal });
  const pending = media.offer(input, request.signal); await until(() => called); dispose();
  assert.match(await pending, /未取得可用/); assert.equal(media.active(), false);
  media.register(async () => ({ mediaRef: 'secret\ncontrol', expiresInSeconds: 1 }), { signal: owner.signal });
  assert.match(await media.offer(input, request.signal), /未取得可用/);
  owner.abort(); assert.equal(media.active(), false);
  assert.equal(await media.offer(input, request.signal), '');
  request.abort(); await assert.rejects(media.offer(input, request.signal));
});
