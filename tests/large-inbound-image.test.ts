/*! Copyright (c) 2026 iinukami and contributors.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import sharp from 'sharp';
import { fixture, until } from './fixture.ts';
import { temporaryDirectory } from './temporary-directory.ts';

const largePng = () => sharp({ create: { width: 1024, height: 800, channels: 3, background: '#87ab05' } })
  .png({ compressionLevel: 0 }).toBuffer();
type Fixture = Awaited<ReturnType<typeof fixture>>;
const delivered = (f: Fixture, id: number) => until(async () =>
  (await f.status()).recent.some((n: any) => n.messageId === String(id) && n.status === 'sent'), 12000);

test('private images over 2 MiB reach recognition by URL, inline OneBot segments and CQ strings, without storing the payload', { timeout: 60000 }, async t => {
  const png = await largePng();
  assert.ok(png.length > 2 * 1024 * 1024);
  const f = await fixture(t, { temporaryDirectory, includeQzone: false, config: {
    maxMediaBytes: png.length, mergeIncoming: false, galleryEnabled: false,
  } });
  await f.online();
  let downloads = 0, recognized = 0;
  const inspectPicture = async (messages: { content?: unknown }[]) => {
    const images = messages.flatMap(m => Array.isArray(m.content) ? m.content.filter(part => part?.type === 'image_url') : []);
    if (!images.length) return;
    assert.equal(images.length, 1);
    const dataUrl = String(images[0].image_url?.url ?? '');
    assert.ok(/^data:image\/(?:jpeg|png|webp);base64,/.test(dataUrl));
    const metadata = await sharp(Buffer.from(dataUrl.split(',')[1], 'base64')).metadata();
    assert.ok(metadata.width && metadata.height);
    assert.ok(Math.abs(metadata.width / metadata.height - 1024 / 800) < 0.02);
    recognized++;
  };
  f.setGenerate(async ({ messages }) => {
    await inspectPicture(messages);
    return { text: 'synthetic reply', toolCalls: [] };
  });
  const endpoint = '/synthetic-image.png?test-only=local-image-marker';
  f.setModelHandler(async (req, res) => {
    if (req.method === 'GET' && req.url === endpoint) {
      downloads++;
      res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': png.length }).end(png);
      return;
    }
    if (req.method !== 'POST' || req.url !== '/v1/chat/completions') { res.writeHead(404).end(); return; }
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const request = JSON.parse(Buffer.concat(chunks).toString());
    await inspectPicture(request.messages);
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ choices: [{ message: { content: 'synthetic green picture' } }] }));
  });
  const inline = 'base64://' + png.toString('base64');
  const segment = (data: Record<string, string>) => [{ type: 'image', data }];
  const cq = '[CQ:image,file=' + inline + ']';
  const cases = [
    { message: segment({ url: f.modelUrl + endpoint }) },
    { message: segment({ url: inline }) },
    { message: segment({ url: f.modelUrl + endpoint, file: inline }) },
    { message: segment({ file: inline }), raw_message: cq },
    { message: cq },
    { message: undefined, raw_message: cq },
  ];
  for (const [index, payload] of cases.entries()) {
    const message_id = 100 + index;
    f.send({ message_id, ...payload });
    await delivered(f, message_id);
    assert.equal(recognized, index + 1);
    assert.equal(f.generations.length, index + 1);
    assert.equal(f.calls.filter(call => call.action === 'send_private_msg').length, index + 1);
    f.send({ message_id, ...payload });
  }
  f.send({ message_id: 200 });
  await delivered(f, 200); // Process all preceding duplicate frames before checking call counts.
  assert.equal(downloads, 1);
  assert.equal(recognized, cases.length);
  assert.equal(f.generations.length, cases.length + 1);
  assert.equal(f.calls.filter(call => call.action === 'send_private_msg').length, cases.length + 1);
  assert.equal(f.calls.filter(call => call.action === 'get_image').length, 0);
  assert.equal(f.connects(), 1);
  const dir = join(f.root, 'plugins/qq/data');
  const ledgers = (await readdir(dir)).filter(name => name.startsWith('inbox-'));
  assert.equal(ledgers.length, cases.length + 1);
  const history = await f.app.memory.readSession(await f.app.sessions.current());
  const artifacts = [JSON.stringify(history), JSON.stringify(await f.status()), ...await Promise.all(ledgers.map(n => readFile(join(dir,n),'utf8')))];
  for (const value of artifacts) assert.ok(!/base64:\/\/|data:image\/|local-image-marker/.test(value));
});

test('over-limit inline images fail visibly while group, non-friend and oversized non-media events cannot enter private chat', { timeout: 30000 }, async t => {
  const png = await largePng();
  const f = await fixture(t, { temporaryDirectory, includeQzone: false, config: {
    maxMediaBytes: png.length - 1, mergeIncoming: false, galleryEnabled: false,
  } });
  await f.online();
  const oversizedImage = [{ type: 'image', data: { url: 'base64://' + png.toString('base64') } }];
  f.send({ message_id: 301, message: oversizedImage });
  await until(async () => (await f.status()).recent.some((n: any) => /大小限制/.test(n.detail ?? '')), 12000);
  const longText = 's'.repeat(270 * 1024);
  const groupIds: string[] = [];
  const controller = new AbortController();
  t.after(() => controller.abort());
  const qq = f.app.runtime.services.get('qq')!.value;
  await qq.registerGroupReceiver((event: { messageId: string }) => { groupIds.push(event.messageId); },
    { signal: controller.signal, allowsGroup: (id: string) => id === '333333' });
  f.send({ message_type: 'group', sub_type: 'normal', group_id: 333333, message_id: 302, message: oversizedImage });
  f.send({ user_id: 999999, message_id: 303, message: oversizedImage });
  f.send({ message_id: 304, message: [{ type: 'text', data: { text: longText } }] });
  f.send({ message_id: 305, message: [{ type: 'image', data: { url: 'base64://aW1hZ2U=' } }, { type: 'text', data: { text: longText } }] });
  f.send({ message_type: 'group', sub_type: 'normal', group_id: 333333, message_id: 306 });
  f.send({ message_id: 307 });
  await delivered(f, 307);
  await until(() => groupIds.includes('306'));
  assert.deepEqual(groupIds, ['306']);
  assert.equal(f.generations.length, 1);
  assert.equal(f.modelCalls.length, 0);
  assert.equal(f.calls.filter(call => call.action === 'send_private_msg').length, 1);
  assert.equal(f.connects(), 1);
  const state = await f.status();
  for (const id of ['302', '303']) assert.ok(!state.recent.some((n: any) => n.messageId === id));
  for (const id of ['304', '305']) assert.ok(!state.recent.some((n: any) => n.messageId === id && n.status === 'sent'));
  assert.ok(!JSON.stringify(state).includes('base64://'));
  assert.ok(!JSON.stringify(state).includes(longText.slice(0, 300)));
});
