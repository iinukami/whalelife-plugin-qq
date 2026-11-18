import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ChannelAdapter } from 'whalelife';
import { parseConfig, parseSegmentation, segmentationDefaults as base } from '../src/config.ts';
import { replyPlan, segmentInterval, segmentText } from '../src/segmentation.ts';
import { fixture, until } from './fixture.ts';

const cfg = (patch = {}) => parseSegmentation({ ...base, enabled: true, interval: '0,0', ...patch });
const sends = (f: Awaited<ReturnType<typeof fixture>>) => f.calls.filter(c => c.action === 'send_private_msg');
const sentText = (f: Awaited<ReturnType<typeof fixture>>) => sends(f).map(c => c.params.message[0].data.text);
const done = (f: Awaited<ReturnType<typeof fixture>>, id = '1', status = 'sent') => until(async () =>
  (await f.status()).recent.some((n: any) => n.messageId === id && n.status === status));

test('regex segmentation retains punctuation, multiline text, emoji and unmatched text; filters empty segments', () => {
  assert.deepEqual(segmentText('你好🙂！\n第二行。尾巴', cfg()), ['你好🙂！', '第二行。', '尾巴']);
  assert.deepEqual(segmentText('开头ABC末尾', cfg({ regex: '(ABC)' })), ['开头', 'ABC', '末尾']);
  assert.deepEqual(segmentText('没匹配🙂', cfg({ regex: 'XYZ' })), ['没匹配🙂']);
  assert.deepEqual(segmentText('abc', cfg({ regex: '(?=b)' })), ['abc']);
  assert.deepEqual(segmentText('？！你好！再见。', cfg({ cleanupRegex: '[。？！]' })), ['你好', '再见']);
  assert.throws(() => segmentText('你好。', cfg({ cleanupRegex: '[\\s\\S]+' })), /没有可发送/);
});

test('threshold is total Unicode length, only-LLM scope is respected and oversized texts retain old protection', () => {
  const text = '🙂！好。';
  assert.deepEqual(replyPlan(text, cfg({ maxLength: 4 }), true).texts, ['🙂！', '好。']);
  assert.deepEqual(replyPlan(text, cfg({ maxLength: 3 }), true).texts, [text]);
  assert.deepEqual(replyPlan(text, cfg(), false).texts, [text]);
  assert.equal(replyPlan(text, cfg({ onlyLLMResult: false }), false).texts.length, 2);
  assert.equal(replyPlan(text, cfg({ enabled: false }), true).texts.length, 1);
  const long = replyPlan('🙂'.repeat(3100), cfg(), true).texts;
  assert.deepEqual(long.map(s => Array.from(s).length), [1500, 1500, 100]);
  assert.throws(() => replyPlan('哈！'.repeat(70), cfg(), true), /64/);
});

test('invalid settings are rejected and pathological segmentation or cleanup is time bounded', { timeout: 5000 }, () => {
  for (const patch of [{ regex: '[' }, { cleanupRegex: '(' }, { interval: '3,1' }, { interval: '1,61' }, { logBase: 1 }, { maxLength: 0 }, { enabled: 'yes' }])
    assert.throws(() => cfg(patch));
  const started = Date.now();
  assert.throws(() => segmentText('a'.repeat(80) + '!', cfg({ regex: '(a+)+$' })), /100 毫秒/);
  assert.throws(() => segmentText('a'.repeat(80) + '!', cfg({ cleanupRegex: '(a+)+$' })), /100 毫秒/);
  assert.ok(Date.now() - started < 2500);
  assert.equal(parseConfig({ schemaVersion: 3, connectionMode: 'desktop' }).segmentedReply.enabled, false);
});

test('random interval boundaries and logarithmic reading delay are bounded and finite', () => {
  assert.equal(segmentInterval('你好', cfg({ interval: '1.5,3.5' }), () => 0), 1500);
  assert.equal(segmentInterval('你好', cfg({ interval: '1.5,3.5' }), () => 1), 3500);
  assert.equal(segmentInterval('你好啊', cfg({ intervalMethod: 'log', logBase: 2 }), () => 0), 2000);
  assert.equal(segmentInterval('one two three', cfg({ intervalMethod: 'log', logBase: 2 }), () => 1), 2500);
  assert.equal(segmentInterval('好'.repeat(100), cfg({ intervalMethod: 'log', logBase: 1.01 }), () => 1), 60000);
});

test('packaged plugin splits LLM reply in order with actual delays, keeps one full memory entry and leaves direct sends intact', async t => {
  const f = await fixture(t, { config: { segmentedReply: cfg({ interval: '0.08,0.08', cleanupRegex: '[。？！]' }) } }); await f.online();
  const response = '你好🙂！第二句？收尾。'; f.setGenerate(async () => ({ text: response, toolCalls: [] }));
  const times: number[] = []; f.setAction(data => { if (data.action === 'send_private_msg') times.push(Date.now()); return false; });
  f.send(); await done(f);
  assert.deepEqual(sentText(f), ['你好🙂', '第二句', '收尾']);
  assert.ok(times[1] - times[0] >= 60); assert.ok(times[2] - times[1] >= 60);
  const id = await f.app.sessions.current(), events = await f.app.memory.readSession(id);
  assert.equal(events.filter((e: any) => e.role === 'assistant' && e.text === response).length, 1);
  await f.app.runtime.services.get('qq')!.value.sendText({ userId: '200002', messageId: 'direct', text: response });
  assert.equal(sentText(f).at(-1), response);
  await f.app.runtime.action('qq', 'reload'); await f.online(); f.send(); await done(f);
  assert.equal(sends(f).length, 4); assert.equal(f.generations.length, 1);
});

test('preview and invalid saves have no send or model side effects; regex timeout stays inside the plugin', async t => {
  const f = await fixture(t); await f.online(); const before = await f.configFile();
  const preview = await f.request('/plugins/qq/segmentation/preview', { text: '你好。再见！', config: cfg() });
  assert.equal(preview.status, 200); assert.deepEqual((await preview.json()).texts, ['你好。', '再见！']);
  assert.equal((await fetch(f.url + '/plugins/qq/segmentation/preview', { method: 'POST', body: '{}' })).status, 401);
  assert.equal((await f.save({ segmentedReply: { ...cfg(), regex: '[' } })).status, 400);
  const timeout = await f.request('/plugins/qq/segmentation/preview', { text: 'a'.repeat(80) + '!', config: cfg({ regex: '(a+)+$' }) });
  assert.equal(timeout.status, 400); assert.match((await timeout.json()).error, /100 毫秒/);
  assert.deepEqual(await f.configFile(), before); assert.equal(f.generations.length, 0); assert.equal(sends(f).length, 0);
  assert.equal((await f.status()).state, 'online'); assert.equal(await f.app.runtime.services.get('witness')!.value.ping(), 'alive');
});

test('stopping between segments cancels remaining output and a restart does not replay the reply', async t => {
  const f = await fixture(t, { config: { segmentedReply: cfg({ interval: '0.5,0.5' }) } }); await f.online();
  f.setGenerate(async () => ({ text: '第一段！第二段！第三段！', toolCalls: [] }));
  f.send(); await until(() => sends(f).length === 1);
  await f.app.runtime.action('qq', 'stop');
  await new Promise(r => setTimeout(r, 600)); assert.equal(sends(f).length, 1);
  await f.app.runtime.action('qq', 'start'); await f.online(); f.send(); await done(f, '1', 'delivery_failed');
  assert.equal(sends(f).length, 1); assert.equal(f.generations.length, 1);
});

test('explicit retry keeps the original segment plan after config change; legacy ledgers keep old chunks', async t => {
  const f = await fixture(t, { config: { segmentedReply: cfg({ interval: '0.4,0.4' }) } }); await f.online();
  let transport: any;
  const register = f.app.channels.register.bind(f.app.channels);
  f.app.channels.register = (adapter: ChannelAdapter, owner?: string) => { transport = adapter.send; return register(adapter, owner); };
  await f.app.runtime.action('qq', 'reload'); await f.online();
  let attempts = 0;
  f.setAction((data, socket) => {
    if (data.action !== 'send_private_msg') return false;
    if (++attempts !== 1) return false;
    socket.send(JSON.stringify({ echo: data.echo, status: 'ok', retcode: 0, data: { message_id: 9001 } }));
    setTimeout(() => socket.terminate(), 30); return true;
  });
  const message = { channel: 'qq', account: '100001', peer: 'direct:200002', sessionId: 'test', text: '甲。乙。丙。', deliveryId: 'test-segment-retry', replyTo: '123' };
  const options = { signal: new AbortController().signal };
  await assert.rejects(transport(message, options)); assert.deepEqual(sentText(f), ['甲。']);
  assert.equal((await f.save({ segmentedReply: cfg({ regex: '.+', cleanupRegex: '[。]' }) })).status, 200); await f.online();
  await transport(message, options); assert.deepEqual(sentText(f), ['甲。', '乙。', '丙。']);
  assert.equal(f.generations.length, 0);
  const dir = join(f.root, 'plugins/qq/data'), file = (await readdir(dir)).find(n => n.startsWith('delivery-'))!;
  const ledger = JSON.parse(await readFile(join(dir, file), 'utf8'));
  // Simulate an old, successfully sent v1 single-message record without a frozen plan.
  delete ledger.texts; delete ledger.intervals; ledger.parts = [{ state: 'sent', messageId: '9001' }];
  await writeFile(join(dir, file), JSON.stringify(ledger));
  await transport(message, options); assert.equal(sends(f).length, 3);
});
