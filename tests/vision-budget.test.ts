/*! Copyright (c) 2026 iinukami and contributors.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import sharp from 'sharp';
import { activePersonaMinimum, baselineBoot } from './host-baseline.ts';
import { MockAgent, getGlobalDispatcher, setGlobalDispatcher } from 'undici';
import type { Context } from 'whalelife';
import type { OneBot } from '../src/onebot.ts';
import { MediaReader } from '../src/media.ts';
import { parseConfig, QQError } from '../src/config.ts';
import { fixture, until } from './fixture.ts';
import { temporaryDirectory } from './temporary-directory.ts';

const png = () => sharp({ create: { width: 4, height: 4, channels: 3, background: '#bada55' } }).png().toBuffer();
const envelope = (message: Record<string, unknown>, finishReason = 'stop') =>
  ({ choices: [{ message, finish_reason: finishReason }] });
const thought = 'SYNTHETIC_PRIVATE_REASONING_MUST_NOT_ESCAPE';
const ordinaryEmpty = '看图模型未返回识别结果。';
const limitEmpty = '看图模型达到输出或上下文上限，未返回识别正文；请检查该模型的输出上限及上下文容量。';
const reasoningEmpty = '看图模型仅返回思考内容，未返回识别正文；请检查该模型的输出上限和思考配置。';

function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
async function media(t: TestContext, parameters: Record<string, unknown>, response: unknown = envelope({ content: '合成小图。' })) {
  const mock = new MockAgent(), original = getGlobalDispatcher();
  mock.disableNetConnect(); setGlobalDispatcher(mock);
  t.after(async () => { setGlobalDispatcher(original); await mock.close(); });
  const bytes = await png(), requests: Record<string, any>[] = [], platform: string[] = [];
  let downloads = 0;
  mock.get('https://images.example').intercept({ path: '/synthetic.png', method: 'GET' }).reply(() => {
    downloads++; return { statusCode: 200, data: bytes, responseOptions: { headers: { 'Content-Type': 'image/png' } } };
  }).persist();
  mock.get('https://vision.example').intercept({ path: '/v1/chat/completions', method: 'POST' }).reply(options => {
    requests.push(JSON.parse(String(options.body)));
    return { statusCode: 200, data: JSON.stringify(response) };
  }).persist();
  const source = freeze({ protocol: 'openai-compatible', type: 'chat', model: 'synthetic-vision',
    base_url: 'https://vision.example/v1', proxy_url: '', api_key: 'synthetic-key', timeout_seconds: 5, parameters });
  const before = structuredClone(source);
  const ctx = { models: { connection: () => source } } as unknown as Context;
  const bot = { request: async (action: string) => {
    platform.push(action); return { url: 'https://images.example/synthetic.png' };
  } } as unknown as OneBot;
  const reader = new MediaReader(ctx, parseConfig({ visionModelId: 'vision', mediaHosts: ['images.example'] }), bot, new AbortController().signal);
  t.after(() => reader.dispose());
  return { reader, requests, platform, downloads: () => downloads, source, before,
    input: { url: 'base64://' + bytes.toString('base64') } };
}

const budgetCases: { name: string; parameters: Record<string, unknown>; budget: Record<string, number> }[] = [
  { name: 'default', parameters: {}, budget: { max_tokens: 2048 } },
  { name: 'explicit max_tokens', parameters: { max_tokens: 8192 }, budget: { max_tokens: 8192 } },
  { name: 'explicit completion budget', parameters: { max_completion_tokens: 4096 }, budget: { max_completion_tokens: 4096 } },
  { name: 'completion budget wins', parameters: { max_tokens: 1024, max_completion_tokens: 8192 }, budget: { max_completion_tokens: 8192 } },
  { name: 'small positive budget stays small', parameters: { max_tokens: 1 }, budget: { max_tokens: 1 } },
  { name: 'largest safe integer stays unchanged', parameters: { max_completion_tokens: Number.MAX_SAFE_INTEGER }, budget: { max_completion_tokens: Number.MAX_SAFE_INTEGER } },
];
for (const entry of budgetCases) test('vision request budget: ' + entry.name, async t => {
  const settings = { thinking: { type: 'enabled', budget_tokens: 512 }, reasoning_effort: 'high',
    temperature: 0.25, top_p: 0.9, custom_provider_option: { keep: true }, ...entry.parameters };
  const h = await media(t, settings);
  assert.equal(await h.reader.image(h.input), '合成小图。');
  assert.equal(h.requests.length, 1, 'one image must make one vision request');
  const body = h.requests[0];
  assert.deepEqual(Object.fromEntries(['max_tokens', 'max_completion_tokens'].filter(key => Object.hasOwn(body, key)).map(key => [key, body[key]])), entry.budget);
  for (const key of ['thinking', 'reasoning_effort', 'temperature', 'top_p', 'custom_provider_option'])
    assert.deepEqual(body[key], settings[key as keyof typeof settings], 'unrelated model parameter changed: ' + key);
  assert.equal(body.model, 'synthetic-vision'); assert.equal(body.stream, false);
  assert.equal(body.messages[0].content[1].type, 'image_url');
  assert.match(body.messages[0].content[1].image_url.url, /^data:image\/png;base64,/);
  assert.deepEqual(h.source, h.before, 'shared model connection must not be mutated');
  assert.equal(h.downloads(), 0); assert.deepEqual(h.platform, []);
});

const invalidValues: { name: string; value: unknown }[] = [
  { name: 'zero', value: 0 }, { name: 'negative', value: -1 }, { name: 'fraction', value: 1.5 },
  { name: 'NaN', value: NaN }, { name: 'Infinity', value: Infinity }, { name: '-Infinity', value: -Infinity },
  { name: 'null', value: null }, { name: 'string', value: '2048' }, { name: 'undefined', value: undefined },
  { name: 'boolean', value: true }, { name: 'object', value: {} }, { name: 'array', value: [] },
  { name: 'unsafe integer', value: Number.MAX_SAFE_INTEGER + 1 },
];
test('vision rejects every explicit invalid budget before platform lookup, media download or model HTTP', async t => {
  for (const field of ['max_tokens', 'max_completion_tokens']) for (const entry of invalidValues) {
    await t.test(field + ': ' + entry.name, async t => {
      // Keep the other field valid: invalid lower-priority max_tokens must not be hidden.
      const parameters = { max_tokens: 2048, max_completion_tokens: 4096, [field]: entry.value };
      const h = await media(t, parameters);
      for (const input of [{ file: 'synthetic.png' }, { url: 'https://images.example/synthetic.png' }]) {
        await assert.rejects(h.reader.image(input), error => {
          assert.ok(error instanceof QQError); assert.equal(error.code, 'vision_parameters');
          assert.ok(error.message.includes(field)); return true;
        });
      }
      assert.deepEqual(h.platform, []); assert.equal(h.downloads(), 0); assert.equal(h.requests.length, 0);
      assert.deepEqual(h.source, h.before);
    });
  }
});

const emptyCases = [
  { name: 'length with no content', response: envelope({ content: null }, 'length'), expected: limitEmpty },
  { name: 'length with whitespace', response: envelope({ content: ' \n\t' }, 'length'), expected: limitEmpty },
  { name: 'length with reasoning', response: envelope({ content: '', reasoning_content: thought }, 'length'), expected: limitEmpty },
  { name: 'reasoning_content only', response: envelope({ reasoning_content: thought }), expected: reasoningEmpty },
  { name: 'reasoning only', response: envelope({ content: ' ', reasoning: thought }), expected: reasoningEmpty },
  { name: 'empty reasoning does not imply a budget failure', response: envelope({ content: '', reasoning_content: '\n', reasoning: ' ' }), expected: ordinaryEmpty },
  { name: 'ordinary empty response', response: envelope({ content: '' }), expected: ordinaryEmpty },
  { name: 'non-text content', response: envelope({ content: [{ type: 'text', text: 'not the supported text field' }] }), expected: ordinaryEmpty },
  { name: 'missing choice', response: { choices: [] }, expected: ordinaryEmpty },
];
for (const entry of emptyCases) test('vision empty response: ' + entry.name, async t => {
  const h = await media(t, {}, entry.response);
  let offers = 0;
  await assert.rejects(h.reader.image(h.input, async () => { offers++; return 'SHOULD_NOT_BE_OFFERED'; }), error => {
    assert.ok(error instanceof QQError); assert.equal(error.code, 'vision_empty'); assert.equal(error.message, entry.expected);
    assert.equal(error.message.includes(thought), false); assert.equal(error.message.includes('700'), false);
    if (entry.expected === reasoningEmpty) assert.doesNotMatch(error.message, /达到|耗尽|预算不足|必定/);
    return true;
  });
  assert.equal(h.requests.length, 1, 'an empty result must not trigger another model call');
  assert.equal(offers, 0, 'a failed recognition must not offer an image to another plugin');
  assert.deepEqual(h.source, h.before);
});

test('vision keeps nonempty text and gallery handoff when finish_reason is length', async t => {
  const content = ' \n' + '图'.repeat(4100);
  const h = await media(t, { max_tokens: 4096 }, envelope({ content, reasoning_content: thought }, 'length'));
  let offers = 0;
  const result = await h.reader.image(h.input, async (bytes, mime) => {
    offers++; assert.equal(mime, 'image/png'); assert.ok(bytes.length > 0); return '[合成图片引用]';
  });
  assert.equal(result, content.slice(0, 4000) + '\n[合成图片引用]');
  assert.equal(result.includes(thought), false); assert.equal(offers, 1); assert.equal(h.requests.length, 1);
  assert.deepEqual(h.source, h.before);
});

type Fixture = Awaited<ReturnType<typeof fixture>>;
const sends = (f: Fixture) => f.calls.filter(call => call.action === 'send_private_msg');
async function settled(f: Fixture, id: number, status: string) {
  await until(async () => {
    const state = await f.status();
    return state.queued === 0 && state.recent.some((notice: any) => notice.messageId === String(id) && notice.status === status);
  });
}
async function failedInboxes(f: Fixture) {
  const root = join(f.root, 'plugins/qq/data');
  const names = (await readdir(root)).filter(name => name.startsWith('inbox-'));
  return (await Promise.all(names.map(name => readFile(join(root, name), 'utf8'))))
    .filter(value => JSON.parse(value).state === 'failed');
}
async function host(t: TestContext, parameters: Record<string, unknown>) {
  const f = await fixture(t, { hostBoot: await baselineBoot(activePersonaMinimum), temporaryDirectory, includeQzone: false,
    config: { mergeIncoming: false, galleryEnabled: false },
    prepareHost: async root => {
      const path = join(root, 'config/config.json'), config = JSON.parse(await readFile(path, 'utf8'));
      config.models.find((entry: any) => entry.id === 'vision').parameters = parameters;
      await writeFile(path, JSON.stringify(config));
    } });
  await f.online();
  const session = await f.app.sessions.create('Synthetic vision budget regression');
  await f.request('/api/session/current', { id: session });
  return { f, session, source: await readFile(join(f.root, 'config/config.json'), 'utf8'),
    pluginConfig: await readFile(join(f.root, 'plugins/qq/data/config.json'), 'utf8') };
}
async function unchanged(h: Awaited<ReturnType<typeof host>>) {
  assert.equal(await readFile(join(h.f.root, 'config/config.json'), 'utf8'), h.source);
  assert.equal(await readFile(join(h.f.root, 'plugins/qq/data/config.json'), 'utf8'), h.pluginConfig);
  assert.equal(h.f.app.runtime.records.get('qq')?.status, 'active');
  assert.equal(await h.f.app.runtime.services.get('witness')!.value.ping(), 'alive');
}

test('packaged vision rejects invalid parameters without generation or sending and preserves failed-ID deduplication', { timeout: 25000 }, async t => {
  const h = await host(t, { max_tokens: 0, max_completion_tokens: 4096 }), { f, session } = h;
  const event = { message_id: 501, message: [{ type: 'image', data: { file: 'synthetic.png' } }] };
  f.send(event); await settled(f, 501, 'failed');
  assert.match((await f.status()).recent.find((item: any) => item.messageId === '501').detail, /max_tokens.*正整数/);
  assert.equal(f.calls.some(call => call.action === 'get_image'), false);
  assert.equal(f.modelCalls.length, 0); assert.equal(f.generations.length, 0); assert.equal(sends(f).length, 0);
  assert.deepEqual(await f.app.memory.readSession(session), []);
  const saved = await failedInboxes(f); assert.equal(saved.length, 1);
  f.send(event); await settled(f, 501, 'uncertain');
  await f.app.runtime.action('qq', 'reload'); await f.online();
  f.send(event); f.send({ message_id: 502 }); await settled(f, 502, 'sent');
  assert.equal(f.modelCalls.length, 0); assert.equal(f.calls.some(call => call.action === 'get_image'), false);
  assert.equal(f.generations.length, 1); assert.equal(sends(f).length, 1);
  assert.deepEqual(await failedInboxes(f), saved);
  assert.equal((await f.app.memory.readSession(session)).filter((row: any) => row.role === 'user').length, 1);
  await unchanged(h);
});

test('packaged empty reasoning result is not retried after duplicate or reload; new text and image still work', { timeout: 30000 }, async t => {
  const h = await host(t, { max_tokens: 1024, max_completion_tokens: 3072, thinking: { type: 'enabled' } }), { f, session } = h;
  const requests: any[] = [];
  let succeeding = false;
  f.setModelHandler(async (req, res) => {
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
    requests.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(envelope(succeeding ? { content: '新图片识别成功。' } : { content: '', reasoning_content: thought })));
  });
  const event = { message_id: 601, message: [{ type: 'image', data: { url: 'base64://' + (await png()).toString('base64') } }] };
  f.send(event); await settled(f, 601, 'failed');
  assert.equal((await f.status()).recent.find((item: any) => item.messageId === '601').detail, reasoningEmpty);
  assert.equal(requests.length, 1); assert.equal(requests[0].max_completion_tokens, 3072);
  assert.equal(Object.hasOwn(requests[0], 'max_tokens'), false); assert.deepEqual(requests[0].thinking, { type: 'enabled' });
  assert.equal(f.generations.length, 0); assert.equal(sends(f).length, 0); assert.deepEqual(await f.app.memory.readSession(session), []);
  const saved = await failedInboxes(f); assert.equal(saved.length, 1); assert.equal(saved[0].includes(thought), false);
  succeeding = true;
  f.send(event); await settled(f, 601, 'uncertain'); assert.equal(requests.length, 1);
  await f.app.runtime.action('qq', 'reload'); await f.online();
  f.send(event); f.send({ message_id: 602 }); await settled(f, 602, 'sent');
  assert.equal(requests.length, 1); assert.equal(f.generations.length, 1); assert.equal(sends(f).length, 1);
  f.send({ ...event, message_id: 603 }); await settled(f, 603, 'sent');
  assert.equal(requests.length, 2); assert.equal(f.generations.length, 2); assert.equal(sends(f).length, 2);
  const lastInput = f.generations.at(-1).messages.filter((message: any) => message.role === 'user').at(-1).content;
  assert.match(lastInput, /新图片识别成功/);
  assert.equal(JSON.stringify(f.generations).includes(thought), false);
  const rows = await f.app.memory.readSession(session);
  assert.equal(rows.filter((row: any) => row.role === 'user').length, 2); assert.equal(JSON.stringify(rows).includes(thought), false);
  assert.deepEqual(await failedInboxes(f), saved); await unchanged(h);
});
