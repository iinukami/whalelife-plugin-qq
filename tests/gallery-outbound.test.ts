import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { baselineBoot, positiveBaselines } from './host-baseline.ts';
import sharp from 'sharp';
import { fixture, until } from './fixture.ts';
import { segmentationDefaults } from '../src/config.ts';

type Fixture = Awaited<ReturnType<typeof fixture>>;
const sends = (f: Fixture) => f.calls.filter(c => c.action === 'send_private_msg');
const split = { ...segmentationDefaults, enabled: true, interval: '0,0', maxLength: 32000 };
async function prepare(root: string) {
  await cp(new URL('../../whalelife-plugin-gallery/dist/gallery', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'), join(root, 'plugins/gallery'), { recursive: true });
  await mkdir(join(root, 'plugins/gallery/data'), { recursive: true });
  await writeFile(join(root, 'plugins/gallery/data/config.json'), JSON.stringify({ schemaVersion: 1, visionModelId: 'vision', embeddingModelId: 'embedding', topK: 5, allowOriginals: false }));
  const path = join(root, 'config/config.json'), config = JSON.parse(await readFile(path, 'utf8'));
  config.models.push({ id: 'embedding', name: 'Embedding', provider: 'test', model: 'embedding', type: 'embedding', enabled: true, dimensions: 2 });
  await writeFile(path, JSON.stringify(config));
}
async function setup(t: Parameters<typeof fixture>[0], options: Parameters<typeof fixture>[1] = {}) {
  const f = await fixture(t, { ...options, config: { permission: 'full', segmentedReply: split, ...options.config }, prepareHost: prepare }); await f.online();
  await until(() => f.app.tools.list().some((x: any) => x.function.name === 'qq_send_gallery'));
  f.setModelHandler(async (req, res) => {
    for await (const _ of req) {}
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ data: [{ embedding: [1, 0] }], usage: { total_tokens: 4 } }));
  });
  const sessionId = typeof f.app.sessions.current === 'function' ? await f.app.sessions.current() : await f.app.sessions.create('media-send');
  const gallery = f.app.runtime.services.get('gallery')!.value;
  const png = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#33aaff' } }).png().toBuffer();
  const pixels = Buffer.alloc(8 * 16 * 3, 60); pixels.fill(210, 8 * 8 * 3);
  const gif = await sharp(pixels, { raw: { width: 8, height: 16, channels: 3, pageHeight: 8 } }).gif().toBuffer();
  const ids: string[] = [];
  for (const [i, bytes] of [png, gif].entries()) {
    const offer = await gallery.offerMedia({ sessionId, base64: bytes.toString('base64') });
    const saved = await f.app.tools.call('gallery_collect', { mediaRef: offer.mediaRef, description: i ? '小猫动态表情' : '普通测试图片', purposes: [i ? 'meme' : 'image'] }, { id: sessionId, permission: 'full' });
    assert.equal(saved.result.state, 'saved'); ids.push(saved.result.asset.id);
  }
  await until(async () => (await (await f.request('/plugins/gallery/state')).json()).jobs.every((j: any) => j.state === 'completed'));
  const call = async (args: any, permission = 'full', signal?: AbortSignal, sid = sessionId) =>
    (await f.app.tools.call('qq_send_gallery', { userId: '200002', actionId: 'gallery-action', parts: [{ type: 'image', id: ids[1] }], ...args }, { id: sid, permission, signal })).result;
  const status = async (actionId = 'gallery-action', sid = sessionId) =>
    (await f.app.tools.call('qq_gallery_delivery', { userId: '200002', actionId }, { id: sid, permission: 'full' })).result;
  return { f, sessionId, gallery, png, gif, ids, call, status };
}

for (const baseline of positiveBaselines) test(`real gallery → QQ on ${baseline}: ordered images/text, GIF bytes, real receipts, public history, duplicates and reload`, { timeout: 40000 }, async t => {
  const hostBoot = await baselineBoot(baseline);
  const { f, sessionId, png, gif, ids, call, status } = await setup(t, { hostBoot });
  const parts = [{ type: 'text', text: '开头。' }, { type: 'image', id: ids[1] }, { type: 'text', text: '中间。继续。' }, { type: 'image', id: ids[0] }, { type: 'text', text: '结尾。' }];
  const r = await call({ parts }); assert.equal(r.status, 'sent'); assert.equal(r.confirmed, true); assert.equal(r.parts.length, 6);
  assert.equal(new Set(r.parts.map((p: any) => p.messageId)).size, 6);
  const emitted = sends(f).map(x => x.params.message[0]);
  assert.deepEqual(emitted.map(x => x.type), ['text', 'image', 'text', 'text', 'image', 'text']);
  assert.deepEqual(emitted.filter(x => x.type === 'text').map(x => x.data.text), ['开头。', '中间。', '继续。', '结尾。']);
  assert.deepEqual(Buffer.from(emitted[1].data.file.slice(9), 'base64'), gif); assert.equal(emitted[1].data.sub_type, 1);
  assert.deepEqual(Buffer.from(emitted[4].data.file.slice(9), 'base64'), png); assert.equal(emitted[4].data.sub_type, 0);
  assert.equal((await call({ parts })).duplicate, true); assert.equal(sends(f).length, 6);
  assert.equal((await call({ parts: [{ type: 'image', id: ids[0] }] })).status, 'blocked'); assert.equal(sends(f).length, 6);
  assert.equal((await status()).status, 'sent');
  const other = await f.app.sessions.create('other'); assert.equal((await status('gallery-action', other)).status, 'not_found');
  const rows = await f.app.memory.readSession(sessionId);
  assert.ok(r.parts.every((p: any) => p.historyRecorded === true));
  const history = await f.app.memoryEngine.state(sessionId);
  assert.equal(history.records.filter((x: any) => x.source === 'qq' && x.outcome === 'succeeded' && x.text.startsWith('向 QQ 好友')).length, 6);
  assert.ok(!JSON.stringify(rows).includes(gif.toString('base64')));
  assert.ok(!JSON.stringify(history).includes(gif.toString('base64')));
  const file = (await readdir(join(f.root, 'plugins/qq/data'))).find(x => x.startsWith('media-delivery-'))!;
  assert.ok(!(await readFile(join(f.root, 'plugins/qq/data', file), 'utf8')).includes('base64'));
  await f.app.runtime.action('qq', 'reload'); await f.online();
  assert.equal((await call({ parts })).status, 'sent'); assert.equal(sends(f).length, 6);
  assert.equal(await f.app.runtime.services.get('witness')!.value.ping(), 'alive');
});

test('model can select from real gallery, send before final reply, and keep the original session when Web switches', async t => {
  const { f, sessionId, ids, status } = await setup(t);
  const b = await f.app.sessions.create('Web B'); let turn = 0, switched = false;
  f.setGenerate(async input => {
    if (turn++ === 0) return { text: '', toolCalls: [{ id: 'find', name: 'gallery_search', arguments: JSON.stringify({ query: '小猫', purpose: 'meme' }) }] };
    const last = JSON.parse(input.messages.at(-1).content).result;
    if (turn === 2) {
      assert.equal(last.candidates[0].id, ids[1]);
      return { text: '', toolCalls: [{ id: 'image', name: 'qq_send_gallery', arguments: JSON.stringify({ userId: '200002', actionId: 'gallery-action', parts: [{ type: 'image', id: ids[1] }] }) }] };
    }
    assert.equal(last.status, 'sent'); return { text: '给你看。', toolCalls: [] };
  });
  f.setAction(async (data) => {
    if (data.action === 'send_private_msg' && !switched) { switched = true; await f.request('/api/session/current', { id: b }); }
    return false;
  });
  f.send(); await until(async () => (await f.status()).recent.some((n: any) => n.status === 'sent'));
  assert.deepEqual(sends(f).map(x => x.params.message[0].type), ['image', 'text']);
  assert.equal((await status()).sessionId, sessionId); assert.equal((await f.app.memory.readSession(b)).length, 0);
});

test('a model failure after successful image delivery does not resend the image or claim an empty final reply succeeded', async t => {
  const { f, ids, status } = await setup(t); let turn = 0;
  f.setGenerate(async () => turn++ === 0 ? { text: '', toolCalls: [{ id: 'image', name: 'qq_send_gallery', arguments: JSON.stringify({ userId: '200002', actionId: 'gallery-action', parts: [{ type: 'image', id: ids[1] }] }) }] } : { text: '', toolCalls: [] });
  f.send(); await until(async () => (await f.status()).recent.some((n: any) => n.status === 'generation_failed'));
  assert.equal((await status()).status, 'sent'); assert.equal(sends(f).length, 1);
  f.send(); await until(async () => (await f.status()).queued === 0);
  assert.equal(f.generations.length, 2); assert.equal(sends(f).length, 1);
});

test('known partial failure continues only on explicit retry, skips confirmed images and preserves frozen text segments after settings change', async t => {
  const { f, ids, call } = await setup(t); let fail = true;
  f.setAction((data, socket) => {
    if (data.action === 'send_private_msg' && data.params.message[0].type === 'text' && fail) {
      socket.send(JSON.stringify({ echo: data.echo, status: 'failed', retcode: 1200, data: {} })); return true;
    }
    return false;
  });
  const parts = [{ type: 'image', id: ids[1] }, { type: 'text', text: '第一句。第二句。' }, { type: 'image', id: ids[0] }];
  const r = await call({ parts }); assert.equal(r.status, 'partial'); assert.deepEqual(r.parts.map((p: any) => p.state), ['sent', 'failed', 'unattempted', 'unattempted']);
  assert.equal((await call({ parts })).duplicate, true); assert.equal(sends(f).length, 2);
  await f.save({ segmentedReply: { ...split, enabled: false } }); await f.online(); fail = false;
  assert.equal((await call({ parts, retry: true })).status, 'sent');
  assert.deepEqual(sends(f).slice(2).map(x => x.params.message[0].type), ['text', 'text', 'image']);
  assert.deepEqual(sends(f).slice(2, 4).map(x => x.params.message[0].data.text), ['第一句。', '第二句。']);
  assert.equal((await call({ parts, retry: true })).duplicate, true); assert.equal(sends(f).length, 5);
});

for (const behavior of ['async', 'missing-id', 'timeout']) test(`uncertain ${behavior} image result prevents even explicit retry across reload`, async t => {
  const { f, call, status } = await setup(t);
  f.setAction((data, socket) => {
    if (data.action !== 'send_private_msg') return false;
    if (behavior !== 'timeout') socket.send(JSON.stringify({ echo: data.echo, status: behavior === 'async' ? 'async' : 'ok', retcode: 0, data: {} }));
    return true;
  });
  assert.equal((await call({})).status, 'uncertain'); assert.equal((await status()).canRetry, false);
  assert.equal((await call({ retry: true })).status, 'uncertain'); assert.equal(sends(f).length, 1);
  await f.app.runtime.action('qq', 'reload'); await f.online();
  assert.equal((await call({ retry: true })).status, 'uncertain'); assert.equal(sends(f).length, 1);
});

for (const stopped of ['gallery-switch', 'qq', 'gallery']) test(`stop ${stopped} cancels remaining media pieces and explicit continuation never repeats a confirmed image`, async t => {
  const { f, ids, call, status } = await setup(t, { config: { minReplyIntervalMs: 600 } });
  const parts = [{ type: 'image', id: ids[1] }, { type: 'image', id: ids[0] }];
  const pending = call({ parts });
  await until(async () => { const r = await status(); return r.parts[0]?.state === 'sent'; });
  if (stopped === 'gallery-switch') assert.equal((await f.save({ galleryEnabled: false })).status, 200);
  else await f.app.runtime.action(stopped, 'stop');
  await pending;
  assert.equal(sends(f).length, 1);
  if (stopped !== 'qq') {
    assert.equal(f.app.runtime.records.get('qq')?.status, 'active');
    assert.ok(!f.app.tools.list().some((x: any) => x.function.name === 'qq_send_gallery'));
    await f.app.runtime.services.get('qq')!.value.sendText({ userId: '200002', messageId: 'while-gallery-off', text: 'normal chat' });
    assert.equal(sends(f).length, 2);
  }
  if (stopped === 'gallery-switch') assert.equal((await f.save({ galleryEnabled: true })).status, 200);
  else await f.app.runtime.action(stopped, 'start');
  await f.online(); await until(() => f.app.tools.list().some((x: any) => x.function.name === 'qq_send_gallery'));
  const before = sends(f).length;
  assert.equal((await call({ parts })).duplicate, true); assert.equal(sends(f).length, before);
  assert.equal((await call({ parts, retry: true })).status, 'sent'); assert.equal(sends(f).length, before + 1);
  assert.equal(sends(f).at(-1).params.message[0].data.file, 'base64://' + (await f.app.runtime.services.get('gallery')!.value.readMedia(ids[0])).base64);
});

test('permission, whitelist, image purpose, archive and raw-path injection are rejected without losing ordinary QQ tools', async t => {
  const { f, ids, gallery, call } = await setup(t);
  assert.equal((await call({ userId: '300003' })).status, 'blocked');
  assert.equal((await call({ sessionId: 'forged' })).status, 'blocked');
  assert.equal((await call({ parts: [{ type: 'image', id: ids[0], mode: 'meme' }] })).status, 'blocked');
  assert.equal((await call({ parts: [{ type: 'image', id: ids[1], file: 'D:/private.png' }] })).status, 'blocked');
  assert.equal((await call({}, 'off')), '工具已关闭');
  await f.save({ permission: 'off' }); await f.online(); assert.equal((await call({})).status, 'blocked');
  await f.save({ permission: 'full' }); await f.online();
  const item = await gallery.describe(ids[1]);
  await f.app.tools.call('gallery_manage', { action: 'archive', id: ids[1], revision: item.revision }, { id: (await f.app.sessions.current()), permission: 'full' });
  assert.equal((await call({})).status, 'blocked'); assert.equal(sends(f).length, 0);
  const raw = await gallery.readMedia(ids[0]);
  await assert.rejects(f.app.runtime.services.get('qq')!.value.sendMedia({ userId: '200002', actionId: 'bad-bytes', sessionId: await f.app.sessions.current(), parts: [{ type: 'image', id: createHash('sha256').update('wrong').digest('hex'), mime: raw.mime, base64: raw.base64, asMeme: false }] }));
  assert.equal(sends(f).length, 0);
  assert.equal(f.app.runtime.records.get('qq')?.status, 'active');
  assert.ok(f.app.tools.list().some((x: any) => x.function.name === 'qq_send_message'));
});
