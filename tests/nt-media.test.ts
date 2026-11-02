import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import sharp from 'sharp';
import { MockAgent, getGlobalDispatcher, setGlobalDispatcher } from 'undici';
import type { Context } from 'whalelife';
import type { OneBot } from '../src/onebot.ts';
import { parseConfig } from '../src/config.ts';
import { MediaReader } from '../src/media.ts';
import { fixture } from './fixture.ts';

const oldHosts = ['qq.com', 'qpic.cn', 'gtimg.cn', 'gtimg.com'];
test('new and unchanged legacy defaults include the QQ NT image host; custom policies stay intact', () => {
  assert.ok(parseConfig({}).mediaHosts.includes('multimedia.nt.qq.com.cn'));
  assert.deepEqual(parseConfig({ mediaHosts: oldHosts }).mediaHosts, [...oldHosts, 'multimedia.nt.qq.com.cn']);
  for (const hosts of [[], ['qq.com'], ['qpic.cn', 'images.example'], [...oldHosts, 'custom.example']])
    assert.deepEqual(parseConfig({ mediaHosts: hosts }).mediaHosts, hosts);
});

test('actual NT image URL passes download, decoding and vision conversion; lookalike domains never reach HTTP', async t => {
  const mock = new MockAgent(), original = getGlobalDispatcher();
  mock.disableNetConnect(); setGlobalDispatcher(mock);
  t.after(async () => { setGlobalDispatcher(original); await mock.close(); });
  const jpeg = await sharp({ create: { width: 298, height: 300, channels: 3, background: '#f7acba' } }).jpeg().toBuffer();
  mock.get('https://multimedia.nt.qq.com.cn').intercept({ path: '/download?appid=1407&rkey=TEST-PRIVATE-TOKEN', method: 'GET' })
    .reply(200, jpeg, { headers: { 'Content-Type': 'image/jpeg' } });
  let visionCalls = 0;
  mock.get('https://vision.example').intercept({ path: '/v1/chat/completions', method: 'POST' }).reply(options => {
    const body = JSON.parse(String(options.body)); visionCalls++;
    assert.equal(body.model, 'test-vision'); assert.equal(body.messages[0].content[1].type, 'image_url');
    assert.match(body.messages[0].content[1].image_url.url, /^data:image\/png;base64,/);
    return { statusCode: 200, data: JSON.stringify({ choices: [{ message: { content: '表情包中的角色正在挥手。' } }] }) };
  });
  const ctx = { models: { connection: () => ({ protocol: 'openai-compatible', type: 'chat', model: 'test-vision',
    base_url: 'https://vision.example/v1', proxy_url: '', api_key: 'test-secret', timeout_seconds: 5, parameters: {} }) } } as unknown as Context;
  const reader = new MediaReader(ctx, parseConfig({ visionModelId: 'vision', mediaHosts: oldHosts }), {} as OneBot, new AbortController().signal);
  t.after(() => reader.dispose());
  const normalized = await reader.normalize({ sender: '200002', peer: 'direct:200002', messageId: '717534834', fingerprint: 'fixture',
    segments: [{ type: 'image', data: { sub_type: 1, file: 'sticker.jpg', file_size: String(jpeg.length),
      url: 'https://multimedia.nt.qq.com.cn/download?appid=1407&rkey=TEST-PRIVATE-TOKEN' } }] });
  assert.match(normalized, /图片／表情包识别：表情包中的角色正在挥手/); assert.equal(visionCalls, 1);
  for (const host of ['multimedia.nt.qq.com.cn.evil.example', 'evil-multimedia.nt.qq.com.cn', 'unknown.qq.com.cn']) {
    await assert.rejects(reader.image({ url: `https://${host}/download?rkey=SECRET-URL-TOKEN` }), error => {
      assert.match(String(error), /未调用识别模型/); assert.ok(String(error).includes(host));
      assert.ok(!String(error).includes('SECRET-URL-TOKEN')); return true;
    });
  }
  assert.equal(visionCalls, 1); mock.assertNoPendingInterceptors();
});

test('installed plugin upgrades only old default media hosts, backs up config and preserves the chosen vision model', async t => {
  const f = await fixture(t, { config: { mediaHosts: oldHosts } }); await f.online();
  const after = await f.configFile();
  assert.deepEqual(after.mediaHosts, [...oldHosts, 'multimedia.nt.qq.com.cn']); assert.equal(after.visionModelId, 'vision');
  const backup = JSON.parse(await readFile(join(f.root, 'plugins/qq/data/config-before-nt-media.json'), 'utf8'));
  assert.deepEqual(backup.mediaHosts, oldHosts); assert.equal(backup.visionModelId, 'vision');
  delete after.mediaHosts; delete backup.mediaHosts; assert.deepEqual(after, backup);
  await f.app.runtime.action('qq', 'reload'); await f.online();
  assert.deepEqual((await f.configFile()).mediaHosts, [...oldHosts, 'multimedia.nt.qq.com.cn']);
});
