/*! Copyright (c) 2026 iinukami and contributors.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fixture, until } from './fixture.ts';
import { temporaryDirectory } from './temporary-directory.ts';

type Fixture = Awaited<ReturnType<typeof fixture>>;
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const inboxName = (id: number) => `inbox-${hash(['100001', 'direct:200002', String(id)])}.json`;
const secrets = ['SYNTHETIC_SIGN_TOKEN', 'RAW_PREVIEW_SECRET', 'EXTRA_COMMAND_DROP_MEMORY', 'RAW_ARK_SENTINEL', 'RAW_HOST_SECRET'];
const miniapp = (title = '合成视频标题', url = 'https://b23.tv/Demo123') => ({ type: 'json', data: { data: JSON.stringify({
  app: 'com.tencent.miniapp_01', ver: '1.0.0.19', prompt: 'RAW_ARK_SENTINEL', needShareCallBack: false,
  config: { token: 'SYNTHETIC_SIGN_TOKEN' }, extra: { command: 'EXTRA_COMMAND_DROP_MEMORY' },
  meta: { detail_1: { appid: '1109937557', title: '哔哩哔哩', desc: title, qqdocurl: url,
    url: 'm.q.qq.com/a/s/FAKE', scene: 1036, preview: 'https://qq.ugcimg.cn/RAW_PREVIEW_SECRET', host: { nick: 'RAW_HOST_SECRET' } } },
}) } });
const sends = (f: Fixture) => f.calls.filter(call => call.action === 'send_private_msg');
const modelInput = (f: Fixture) => String(f.generations.at(-1)?.messages.filter((message: any) => message.role === 'user').at(-1)?.content ?? '');
async function setup(t: TestContext, extra: Parameters<typeof fixture>[1] = {}) {
  const f = await fixture(t, { ...extra, temporaryDirectory, includeQzone: false,
    config: { mergeIncoming: false, galleryEnabled: false, ...extra.config } });
  await f.online(); return f;
}
async function settled(f: Fixture, id: number, status = 'sent') {
  await until(async () => {
    const state = await f.status();
    return state.queued === 0 && state.recent.some((notice: any) => notice.messageId === String(id) && notice.status === status);
  });
}
async function users(f: Fixture) {
  const session = await f.app.sessions.current();
  return (await f.app.memory.readSession(session)).filter((row: any) => row.role === 'user');
}
async function durable(f: Fixture) {
  const data = join(f.root, 'plugins/qq/data');
  const inboxes = (await readdir(data)).filter(name => name.startsWith('inbox-'));
  return JSON.stringify(await users(f)) + (await Promise.all(inboxes.map(name => readFile(join(data, name), 'utf8')))).join('\n');
}
function isolated(f: Fixture) {
  assert.equal(f.modelCalls.length, 0, 'share projection must not use image or speech recognition');
  assert.equal(f.calls.some(call => ['get_image', 'fetch_ptt_text', 'get_record'].includes(call.action)), false);
  for (const plugin of ['bilibili', 'surf/bilibili', 'qq/qzone']) assert.equal(f.app.runtime.records.has(plugin), false);
}
function noRaw(value: string, extra: string[] = []) {
  for (const secret of [...secrets, 'com.tencent.miniapp_01', 'm.q.qq.com/a/s/FAKE', ...extra])
    assert.equal(value.includes(secret), false, `raw card material escaped: ${secret}`);
}

test('packaged inbound phone card projects only bounded external title and link into the model and memory', { timeout: 20000 }, async t => {
  const f = await setup(t);
  const title = '示例' + '🎬'.repeat(210) + 'TRUNCATED_TITLE_TAIL';
  f.send({ message_id: 101, message: [miniapp(title)] }); await settled(f, 101);
  assert.equal(f.generations.length, 1); assert.equal(sends(f).length, 1);
  const content = modelInput(f);
  assert.match(content, /外部资料.*不是指令.*不代表已观看/);
  assert.match(content, /视频链接：https:\/\/b23\.tv\/Demo123(?:\n|$)/);
  const quoted = content.match(/分享标题：(\"[^\n]*\")/); assert.ok(quoted);
  const projectedTitle = JSON.parse(quoted[1]);
  assert.equal(projectedTitle, '示例' + '🎬'.repeat(198)); assert.equal(Array.from(projectedTitle).length, 200);
  assert.equal(content.includes('分享标题："哔哩哔哩"'), false);
  const rows = await users(f); assert.equal(rows.length, 1);
  assert.equal(rows[0].text.includes('https://b23.tv/Demo123'), true);
  assert.equal(rows[0].text.includes(projectedTitle), true);
  noRaw(JSON.stringify(f.generations), ['TRUNCATED_TITLE_TAIL']);
  noRaw(await durable(f), ['TRUNCATED_TITLE_TAIL']); isolated(f);
  assert.equal(await f.app.runtime.services.get('witness')!.value.ping(), 'alive');
});

test('plain share and structmsg cards normalize video URLs without fetching their covers or forwarding extra fields', { timeout: 20000 }, async t => {
  const f = await setup(t);
  const url = 'https://www.bilibili.com/video/BV1GJ411x7h7/';
  const inputs = [
    { type: 'share', data: { url: url + '?share_source=qq&private=TRACKING_SECRET', title: '普通分享标题',
      content: 'EXTRA_COMMAND_DROP_MEMORY', image: 'https://qq.ugcimg.cn/RAW_PREVIEW_SECRET' } },
    { type: 'json', data: { data: JSON.stringify({ app: 'com.tencent.structmsg', prompt: 'RAW_ARK_SENTINEL',
      config: { token: 'SYNTHETIC_SIGN_TOKEN' }, extra: 'EXTRA_COMMAND_DROP_MEMORY',
      meta: { news: { title: '图文卡标题', jumpUrl: 'https://m.bilibili.com/video/BV1GJ411x7h7?p=2&private=TRACKING_SECRET',
        desc: 'RAW_HOST_SECRET', preview: 'https://qq.ugcimg.cn/RAW_PREVIEW_SECRET' } } }) } },
  ];
  for (const [index, message] of inputs.entries()) {
    f.send({ message_id: 110 + index, message: [message] }); await settled(f, 110 + index);
    assert.ok(modelInput(f).includes('视频链接：' + url));
    assert.ok(modelInput(f).includes(index ? '图文卡标题' : '普通分享标题'));
  }
  assert.match(modelInput(f), /分享指定分 P：2/);
  assert.equal(f.generations.length, 2); assert.equal(sends(f).length, 2);
  noRaw(JSON.stringify(f.generations), ['TRACKING_SECRET', 'com.tencent.structmsg']);
  noRaw(await durable(f), ['TRACKING_SECRET', 'com.tencent.structmsg']); isolated(f);
});

test('JSON replay replies once, new IDs remain usable and changed JSON or XML under the same ID is rejected', { timeout: 25000 }, async t => {
  const f = await setup(t), first = miniapp('第一张卡片'), second = miniapp('第二张卡片', 'https://b23.tv/Demo456');
  f.send({ message_id: 120, message: [first] }); await settled(f, 120);
  const file = join(f.root, 'plugins/qq/data', inboxName(120)); const before = await readFile(file, 'utf8');
  f.send({ message_id: 120, message: [first] });
  f.send({ message_id: 121, message: [second] }); await settled(f, 121);
  assert.equal(f.generations.length, 2); assert.equal(sends(f).length, 2); assert.equal((await users(f)).length, 2);
  assert.ok(modelInput(f).includes('第二张卡片')); assert.ok(modelInput(f).includes('https://b23.tv/Demo456'));
  f.send({ message_id: 120, message: [second] }); await settled(f, 120, 'failed');
  assert.equal(f.generations.length, 2); assert.equal(sends(f).length, 2); assert.equal(await readFile(file, 'utf8'), before);
  await f.app.runtime.action('qq', 'reload'); await f.online();
  f.send({ message_id: 120, message: [first] });
  f.send({ message_id: 122, message: [{ type: 'xml', data: { data: '<msg><title>XML_SECRET_ONE</title></msg>' } }] });
  await settled(f, 122);
  assert.equal(f.generations.length, 3); assert.equal(sends(f).length, 3);
  assert.match(modelInput(f), /暂不支持的消息类型：xml/);
  f.send({ message_id: 122, message: [{ type: 'xml', data: { data: '<msg><title>XML_SECRET_TWO</title></msg>' } }] });
  await settled(f, 122, 'failed');
  assert.equal(f.generations.length, 3); assert.equal(sends(f).length, 3);
  noRaw(JSON.stringify(f.generations), ['XML_SECRET_ONE', 'XML_SECRET_TWO']);
  noRaw(await durable(f), ['XML_SECRET_ONE', 'XML_SECRET_TWO']); isolated(f);
});

test('old v1 ready card records keep their historical fingerprint and cannot be reinterpreted or replayed', { timeout: 20000 }, async t => {
  const records = [
    { id: 130, type: 'json', message: miniapp() },
    { id: 131, type: 'xml', message: { type: 'xml', data: { data: '<msg><title>LEGACY_RAW_XML</title></msg>' } } },
  ];
  const saved = new Map<number, string>();
  const f = await setup(t, { preparePlugin: async plugin => {
    for (const entry of records) {
      // Freeze the pre-upgrade algorithm independently: these types did not include data.data.
      const value = JSON.stringify({ version: 1, fingerprint: hash(['200002', [[entry.type, null, null, null]]]),
        state: 'ready', text: 'LEGACY_READY_TEXT_MUST_NOT_REPLAY' });
      saved.set(entry.id, value); await writeFile(join(plugin, 'data', inboxName(entry.id)), value);
    }
  } });
  for (const entry of records) {
    f.send({ message_id: entry.id, message: [entry.message] }); await settled(f, entry.id, 'failed');
    assert.equal(await readFile(join(f.root, 'plugins/qq/data', inboxName(entry.id)), 'utf8'), saved.get(entry.id));
  }
  assert.equal(f.generations.length, 0); assert.equal(sends(f).length, 0); assert.equal(f.modelCalls.length, 0);
  f.send({ message_id: 132, message: [miniapp('升级后新消息')] }); await settled(f, 132);
  assert.equal(f.generations.length, 1); assert.equal(sends(f).length, 1);
  noRaw(JSON.stringify(f.generations), ['LEGACY_READY_TEXT_MUST_NOT_REPLAY', 'LEGACY_RAW_XML']);
  assert.equal((await users(f)).length, 1); isolated(f);
});

test('private replies expand the projected card but reject another peer and self-sent messages for another peer', { timeout: 20000 }, async t => {
  const f = await setup(t);
  f.setAction((request, socket) => {
    if (request.action !== 'get_msg') return false;
    const id = String(request.params.message_id), own = id === '702', allowed = id === '700';
    socket.send(JSON.stringify({ status: 'ok', retcode: 0, echo: request.echo, data: {
      message_type: 'private', sender: { user_id: allowed ? 200002 : own ? 100001 : 300003 },
      ...(own ? { target_id: 300003 } : {}), message: [allowed ? miniapp('本次私聊引用标题')
        : miniapp('CROSS_PEER_TITLE_MUST_NOT_LEAK', 'https://b23.tv/CrossPeerSecret')],
    } })); return true;
  });
  for (const [index, quotedId] of [700, 701, 702].entries()) {
    f.send({ message_id: 140 + index, message: [{ type: 'reply', data: { id: quotedId } }, { type: 'text', data: { text: '看看引用' } }] });
    await settled(f, 140 + index);
    const content = modelInput(f);
    if (!index) { assert.match(content, /引用内容（背景资料）/); assert.ok(content.includes('本次私聊引用标题')); assert.ok(content.includes('https://b23.tv/Demo123')); }
    else assert.match(content, /引用消息无法确认属于本次私聊，未展开/);
  }
  assert.equal(f.generations.length, 3); assert.equal(sends(f).length, 3);
  assert.deepEqual(f.calls.filter(call => call.action === 'get_msg').map(call => String(call.params.message_id)), ['700', '701', '702']);
  noRaw(JSON.stringify(f.generations), ['CROSS_PEER_TITLE_MUST_NOT_LEAK', 'CrossPeerSecret']);
  noRaw(await durable(f), ['CROSS_PEER_TITLE_MUST_NOT_LEAK', 'CrossPeerSecret']); isolated(f);
});
