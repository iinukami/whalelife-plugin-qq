/*! Copyright (c) 2026 iinukami and contributors.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import sharp from 'sharp';
import { fixture, until } from './fixture.ts';
import { temporaryDirectory } from './temporary-directory.ts';

type ProviderMode = 'accept' | 'unsupported' | 'limited' | 'timeout';
type Part = { type: string; text?: string; image_url?: { url: string } };
type ModelBody = { model: string; stream: boolean; messages: { role: string; content: string | null | Part[] }[] };
const question = 'SYNTHETIC_COLOR_QUESTION';
const answer = 'SYNTHETIC_FINAL_ANSWER';
const fallbackAnswer = 'SYNTHETIC_ASSISTED_ANSWER';
const description = 'SYNTHETIC_AUXILIARY_DESCRIPTION';
const imageUrls = (body: ModelBody) => body.messages.flatMap(m =>
  Array.isArray(m.content) ? m.content.flatMap(part => part.image_url?.url ?? []) : []);

async function imageSession(t: TestContext, mode: ProviderMode, input: 'caption' | 'standalone' | 'append' | 'removed-helper' = 'caption') {
  const f = await fixture(t, { temporaryDirectory, includeQzone: false, modelTimeout: mode === 'timeout' ? 1 : 6,
    config: { galleryEnabled: false, ...(input === 'standalone' ? { mergeIncoming: false, visionModelId: '' } : {}),
      ...(input === 'removed-helper' ? { visionModelId: 'previous-model-no-longer-configured' } : {}) } });
  // Use the host's actual HTTP/SSE client so provider error classification and retry policy are exercised.
  assert.ok(Object.hasOwn(f.app.llm, 'chat'), 'fixture did not install its mock');
  Reflect.deleteProperty(f.app.llm, 'chat');
  assert.equal(typeof f.app.llm.chat, 'function', 'selected host must provide a real LLM client');
  const probe = f.app.channels.register({ id: 'image-test', account: 'synthetic', persona: 'a', send: async () => {} });
  const supportsNative = probe.supportsImageInput === true;
  probe.dispose();
  const requests: ModelBody[] = [];
  let releaseFirst!: () => void;
  const firstHeld = new Promise<void>(resolve => { releaseFirst = resolve; });
  f.setModelHandler(async (req, res) => {
    const parts: Buffer[] = [];
    for await (const part of req) parts.push(Buffer.from(part));
    const body: ModelBody = JSON.parse(Buffer.concat(parts).toString('utf8'));
    requests.push(body);
    const stale = input === 'append' && requests.length === 1;
    if (stale) await firstHeld;
    if (body.model === 'chat' && imageUrls(body).length) {
      if (mode === 'timeout') return; // The client aborts this local request at its configured deadline.
      if (mode === 'unsupported' || mode === 'limited') {
        const limited = mode === 'limited';
        res.writeHead(limited ? 429 : 400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { type: limited ? 'rate_limit_error' : 'invalid_request_error',
          message: limited ? 'Too many requests' : 'This model does not support image inputs' } }));
        return;
      }
    }
    let content = answer;
    if (body.model === 'vision') content = description;
    else if (stale) content = 'STALE_CANDIDATE';
    else if (mode === 'unsupported' && JSON.stringify(body.messages).includes(description)) content = fallbackAnswer;
    if (body.stream) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.end('data: ' + JSON.stringify({ choices: [{ delta: { content }, finish_reason: 'stop' }] }) + '\n\ndata: [DONE]\n\n');
    } else {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }] }));
    }
  });
  await f.online();
  const session = await f.app.sessions.create('Synthetic QQ native image');
  assert.ok((await f.request('/api/session/current', { id: session })).ok);
  const picture = await sharp({ create: { width: 18, height: 12, channels: 3, background: '#1a73e8' } }).png().toBuffer();
  const event = { message_id: 8101, message: [
    ...(input === 'standalone' ? [] : [{ type: 'text', data: { text: question } }]),
    { type: 'image', data: { url: 'base64://' + picture.toString('base64') } },
  ] };
  if (input === 'append') {
    try {
      f.send({ message_id: 8100, message: [{ type: 'text', data: { text: 'SYNTHETIC_FIRST_MESSAGE' } }] });
      await until(() => requests.length === 1);
      f.send(event);
      await until(async () => (await f.status()).recent.some((row: any) =>
        row.messageId === String(event.message_id) && row.status === 'merged'));
    } finally { releaseFirst(); }
  } else f.send(event);
  await until(async () => {
    const status = await f.status();
    return status.queued === 0 && status.recent.some((row: any) =>
      row.messageId === String(event.message_id) && ['sent', 'failed', 'generation_failed'].includes(row.status));
  }, 16000);
  const outgoing = f.calls.filter(call => call.action === 'send_private_msg').map(call => call.params.message);
  const history: { role?: string; external_message_id?: string }[] = await f.app.memory.readSession(session);
  return { root: f.root, f, event, session, supportsNative, requests, outgoing, picture, history, setMode(next: ProviderMode) { mode = next; } };
}

async function checkTransientImages(root: string, original: Buffer, requests: ModelBody[]) {
  const images = new Set([original.toString('base64'), ...requests.flatMap(imageUrls).map(data => {
    assert.match(data, /^data:image\/(png|jpeg|webp);base64,/);
    return data.slice(data.indexOf(',') + 1);
  })]);
  for (const dir of ['memory', 'logs', 'plugins/qq/data']) {
    const base = join(root, dir);
    let entries;
    try { entries = await readdir(base, { withFileTypes: true, recursive: true }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const data = await readFile(join(entry.parentPath, entry.name));
      for (const image of images) {
        assert.ok(!data.includes(image) && !data.includes(Buffer.from(image, 'base64')), dir + '/' + entry.name + ' persisted temporary image content');
      }
    }
  }
}

test('QQ image handling on the selected host', async t => {
  const sample = await imageSession(t, 'accept');
  if (process.env.QQ_EXPECT_IMAGE_SUPPORT === 'legacy')
    assert.equal(sample.supportsNative, false, 'The selected legacy baseline unexpectedly supports native inbound images');
  if (!sample.supportsNative) {
    assert.ok(!process.env.QQ_IMAGE_HOST_PATH || process.env.QQ_EXPECT_IMAGE_SUPPORT === 'legacy',
      'The explicitly selected image test host lacks supportsImageInput');
    await t.test('legacy host uses its configured auxiliary model before the conversation', async () => {
      assert.deepEqual(sample.requests.map(r => r.model), ['vision', 'chat']);
      assert.deepEqual(sample.requests.map(r => imageUrls(r).length), [1, 0]);
      assert.ok(JSON.stringify(sample.requests[1].messages).includes(description));
      assert.deepEqual(sample.outgoing, [[{ type: 'text', data: { text: answer } }]]);
      await checkTransientImages(sample.root, sample.picture, sample.requests);
    });
    return;
  }

  await t.test('the same QQ session first sees pixels directly, then falls back once only on explicit rejection', async () => {
    const { root, f, event, session, picture, requests } = sample;
    const socket = f.socket();
    assert.deepEqual(requests.map(r => [r.model, imageUrls(r).length]), [['chat', 1]]);
    const rgb = await sharp(Buffer.from(imageUrls(requests[0])[0].split(',')[1], 'base64')).removeAlpha().raw().toBuffer();
    const expected = [26, 115, 232]; // Allow lossy JPEG/WebP previews of the solid blue fixture.
    for (const [channel, value] of expected.entries()) assert.ok(Math.abs(rgb[channel] - value) <= 5);
    assert.ok(requests[0].messages.some(m => m.role === 'user' && JSON.stringify(m.content).includes(question)));

    sample.setMode('unsupported');
    const second = await sharp({ create: { width: 16, height: 10, channels: 3, background: '#ff8b14' } }).png().toBuffer();
    const secondCaption = 'SYNTHETIC_SECOND_PICTURE';
    const secondEvent = { message_id: 8110, message: [{ type: 'text', data: { text: secondCaption } },
      { type: 'image', data: { url: 'base64://' + second.toString('base64') } }] };
    f.send(secondEvent);
    await until(async () => (await f.status()).recent.some((n: any) => n.messageId === '8110' && n.status === 'sent'));
    f.send(event);
    f.send(secondEvent);
    await until(async () => {
      const status = await f.status();
      return status.queued === 0 && ['8101', '8110'].every(id =>
        status.recent.some((row: any) => row.messageId === id && row.status === 'duplicate'));
    });
    assert.deepEqual(requests.map(r => [r.model, imageUrls(r).length]), [['chat', 1], ['chat', 1], ['vision', 1], ['chat', 0]]);
    assert.ok(JSON.stringify(requests[3].messages).includes(description));
    assert.ok(JSON.stringify(requests[3].messages).includes(secondCaption));
    assert.deepEqual(f.calls.filter(c => c.action === 'send_private_msg').map(c => c.params.message),
      [answer, fallbackAnswer].map(text => [{ type: 'text', data: { text } }]));
    const data = join(root, 'plugins/qq/data');
    const files = (await readdir(data)).filter(file => file.startsWith('delivery-'));
    const ledgers = await Promise.all(files.map(async file => JSON.parse(await readFile(join(data, file), 'utf8'))));
    assert.deepEqual(ledgers.map(l => l.parts).sort((a, b) => a[0].messageId.localeCompare(b[0].messageId)),
      ['9000', '9001'].map(messageId => [{ state: 'sent', messageId }]));
    assert.equal(f.socket(), socket);
    assert.equal(f.connects(), 1);
    assert.equal(await f.app.sessions.current(), session);
    const rows: { role?: string; persona_id?: string; external_message_id?: string }[] = await f.app.memory.readSession(session);
    assert.deepEqual(rows.filter(r => r.role === 'user').map(r => r.external_message_id), ['8101', '8110']);
    assert.deepEqual(rows.filter(r => r.role === 'user' || r.role === 'assistant').map(r => [r.role, r.persona_id]),
      [['user', 'a'], ['assistant', 'a'], ['user', 'a'], ['assistant', 'a']]);
    await checkTransientImages(root, picture, requests);
    await checkTransientImages(root, second, requests);
  });

  await t.test('receive handles an image-only message without an auxiliary model and preserves deduplication across reload', async t => {
    const { f, event, requests, outgoing, history } = await imageSession(t, 'accept', 'standalone');
    assert.deepEqual(requests.map(r => r.model), ['chat']);
    assert.deepEqual(requests.map(r => imageUrls(r).length), [1]);
    assert.deepEqual(outgoing, [[{ type: 'text', data: { text: answer } }]]);
    assert.deepEqual(history.filter(r => r.role === 'user').map(r => r.external_message_id), ['8101']);
    await f.app.runtime.action('qq', 'reload');
    await f.online();
    f.send(event);
    f.send({ message_id: 8102, message: [{ type: 'text', data: { text: 'FRESH_AFTER_RELOAD' } }] });
    await until(async () => {
      const status = await f.status();
      return status.queued === 0 && status.recent.some((r: any) => r.messageId === '8102' && r.status === 'sent');
    });
    assert.deepEqual(requests.map(r => [r.model, imageUrls(r).length]), [['chat', 1], ['chat', 0]]);
    assert.ok(JSON.stringify(requests[1].messages).includes('FRESH_AFTER_RELOAD'));
    assert.equal(f.calls.filter(call => call.action === 'send_private_msg').length, 2);
  });

  await t.test('an old removed auxiliary model does not disable native QQ, and saving a new unknown model is rejected', async t => {
    const { f, outgoing, requests } = await imageSession(t, 'accept', 'removed-helper');
    assert.deepEqual(requests.map(r => [r.model, imageUrls(r).length]), [['chat', 1]]);
    assert.deepEqual(outgoing, [[{ type: 'text', data: { text: answer } }]]);
    const save = await f.save({ visionModelId: 'different-unknown-model' });
    assert.equal(save.ok, false);
    assert.equal((await f.configFile()).visionModelId, 'previous-model-no-longer-configured');
    assert.equal((await f.status()).state, 'online');
  });

  await t.test('an image appended during generation reaches the next request and produces one final reply', async t => {
    const { requests, outgoing, history } = await imageSession(t, 'accept', 'append');
    assert.deepEqual(requests.map(r => [r.model, imageUrls(r).length]), [['chat', 0], ['chat', 1]]);
    assert.ok(JSON.stringify(requests[1].messages).includes(question));
    assert.deepEqual(outgoing, [[{ type: 'text', data: { text: answer } }]]);
    assert.deepEqual(history.filter(r => r.role === 'user').map(r => r.external_message_id), ['8100', '8101']);
    assert.equal(history.filter(r => r.role === 'assistant').length, 1);
    assert.ok(!JSON.stringify(history).includes('STALE_CANDIDATE'));
  });

  for (const mode of ['limited', 'timeout'] as const) {
    await t.test(mode + ' remains a provider failure without sending pixels to another model', async t => {
      const { requests, outgoing, history } = await imageSession(t, mode);
      assert.deepEqual(requests.map(r => r.model), ['chat']);
      assert.equal(imageUrls(requests[0]).length, 1);
      assert.deepEqual(outgoing, []);
      assert.equal(history.some(r => r.role === 'assistant'), false);
    });
  }
});
