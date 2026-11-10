/*! Copyright (c) 2026 iinukami and contributors.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Context } from 'whalelife';
import { OutboundMiniApp, type MiniAppShare } from '../src/outbound-miniapp.ts';
import { defaults, QQError } from '../src/config.ts';

const input: MiniAppShare = { userId: '200002', actionId: 'bilibili:test-1', sessionId: 'session-a', personaId: 'a',
  preset: 'bili', title: 'Transient synthetic title', description: 'Transient synthetic description',
  previewUrl: 'https://i0.hdslb.com/bfs/archive/synthetic.jpg', jumpPath: 'pages/video/video?avid=123456',
  webUrl: 'https://www.bilibili.com/video/BV1GJ411x7h7/' };
function ark() {
  return { app: 'com.tencent.miniapp_01', ver: '1.0.0.0', view: 'view_8C8E89B49BE609866298ADDFF2DBABA4',
    config: { token: 'synthetic-signature-never-store', ctime: 1 },
    meta: { detail_1: { appid: '1109937557', scene: 1036, url: input.jumpPath, title: input.title, desc: input.description,
      preview: input.previewUrl, host: { uin: 100001, nick: 'synthetic-host-never-store' } } },
    miniappShareOrigin: 3, miniappOpenRefer: '10002' };
}
function nativeArk() {
  const value = ark();
  return { ...value, meta: { detail_1: { ...value.meta.detail_1,
    title: '哔哩哔哩', desc: input.title, qqdocurl: input.webUrl,
    url: 'm.q.qq.com/a/s/' + 'a'.repeat(32), preview: 'https://qq.ugcimg.cn/v1/synthetic-preview' } } };
}
function fixture() {
  const files = new Map<string, unknown>(), experiences: any[] = [], generated: any[] = [], sent: string[] = [];
  let saveHook: ((value: any) => void) | undefined, sessionHook: (() => void) | undefined;
  let generateHook: (() => Promise<any> | any) | undefined, sendHook: (() => Promise<string> | string) | undefined;
  const config = { ...defaults, accountId: '100001', allowedUsers: ['200002'], personaId: 'a', permission: 'full' as const };
  const ctx = {
    config: { read: async (name: string) => structuredClone(files.get(name) ?? {}),
      save: async (name: string, value: unknown) => { saveHook?.(value); files.set(name, structuredClone(value)); } },
    sessions: { list: async () => [{ id: 'session-a' }], context: async (sessionId: string, persona: string) => { sessionHook?.(); assert.equal(persona, 'a'); if (sessionId !== 'session-a') throw Error('private missing session'); return {}; } },
    memory: { recordExperience: async (_session: string, value: any) => { experiences.push(value); } },
  } as unknown as Context;
  const create = () => new OutboundMiniApp(ctx, config, async params => {
    generated.push(params); return generateHook ? generateHook() : { data: ark() };
  }, async (_userId, payload, _signal, pending, dispatched) => {
    await pending(); dispatched(); sent.push(payload); return sendHook ? sendHook() : '9001';
  });
  const controller = new AbortController(); let service = create();
  return { files, experiences, generated, sent, controller, config,
    run: (patch: Partial<MiniAppShare> = {}, options: any = { permission: 'full' }, guard = async () => {}, close = async () => {}) => service.execute({ ...input, ...patch }, options, controller.signal, guard, close),
    status: () => service.status({ userId: input.userId, actionId: input.actionId, sessionId: input.sessionId }, controller.signal),
    reload: () => { service = create(); },
    save: (hook: typeof saveHook) => { saveHook = hook; }, session: (hook: typeof sessionHook) => { sessionHook = hook; },
    generate: (hook: typeof generateHook) => { generateHook = hook; }, send: (hook: typeof sendHook) => { sendHook = hook; },
  };
}

test('signed mini-app preserves full QQ payload, hashes private fields, confirms once and survives reload', async () => {
  const f = fixture(); assert.equal((await f.status()).status, 'not_found');
  const result = await f.run();
  assert.deepEqual(result, { status: 'sent', confirmed: true, duplicate: false, retryAutomatically: false, canRetry: false, ledgerSaved: true, platformMessageId: '9001' });
  assert.deepEqual(f.generated[0], { type: 'bili', title: input.title, desc: input.description, picUrl: input.previewUrl, jumpUrl: input.jumpPath, webUrl: input.webUrl });
  assert.deepEqual(JSON.parse(f.sent[0]), ark());
  assert.equal((await f.run()).duplicate, true); f.reload(); assert.equal((await f.run()).duplicate, true);
  assert.equal((await f.run({ title: 'different content' })).error, 'conflict');
  assert.equal(f.sent.length, 1); assert.equal(f.generated.length, 1); assert.equal(f.experiences.length, 1);
  const durable = JSON.stringify([...f.files, ...f.experiences]);
  for (const secret of [input.title, input.description, input.previewUrl, input.webUrl, input.jumpPath, 'synthetic-signature', 'synthetic-host', input.userId, input.sessionId]) assert.ok(!durable.includes(secret), secret);
});

test('permissions, recipient, session and unstructured/unsafe content fail before protocol calls', async () => {
  const patches: any[] = [
    { userId: 200002 }, { userId: '300003' }, { userId: '100001' }, { sessionId: 'not-existing' }, { actionId: 'spaces not allowed' },
    { actionId: 'x'.repeat(129) }, { preset: 'weibo' }, { title: '' }, { title: 'x'.repeat(201) }, { description: 'x'.repeat(501) },
    { title: 'bad\u0000title' }, { rawArkData: '{}' }, { previewUrl: 'http://i0.hdslb.com/test' }, { previewUrl: 'https://hdslb.com.evil.invalid/test' },
    { previewUrl: 'https://u:p@i0.hdslb.com/test' }, { previewUrl: 'https://i0.hdslb.com:8443/test' },
    { webUrl: 'https://www.bilibili.com/video/BV1GJ411x7h7/?secret=x' }, { jumpPath: 'https://www.bilibili.com/' },
    { jumpPath: 'pages/video/video?avid=0' }, { jumpPath: 'pages/video/video?avid=123&x=2' },
    { jumpPath: 'pages/video/video?bvid=BV1Z24J6dEBk' },
  ];
  for (const patch of patches) { const f = fixture(); assert.equal((await f.run(patch)).status, 'not_sent'); assert.equal(f.generated.length, 0); assert.equal(f.sent.length, 0); }
  const f = fixture(); assert.equal((await f.run({}, { permission: 'safe' })).error, 'permission');
  assert.equal((await f.run({}, { permission: 'full', retry: true })).error, 'invalid_input');
  f.config.permission = 'off' as any; assert.equal((await f.run()).error, 'permission');
});

test('missing signature, wrong app/target and malformed card never dispatch or get rewritten', async () => {
  const cards = [ {}, { data: '{}' }, { data: { ...ark(), app: 'other' } }, { data: { ...ark(), config: {} } },
    { data: { ...ark(), meta: { detail_1: { ...ark().meta.detail_1, url: 'pages/other' } } } },
    { data: { ...ark(), meta: { detail_1: { ...ark().meta.detail_1, appid: '123' } } } },
    { data: { ...ark(), huge: 'x'.repeat(65536) } } ];
  for (const card of cards) {
    const f = fixture(); f.generate(() => card); const result = await f.run();
    assert.equal(result.status, 'not_sent'); assert.equal(result.error, 'invalid_card'); assert.equal(f.sent.length, 0);
    f.reload(); assert.equal((await f.run()).duplicate, true); assert.equal(f.generated.length, 1);
  }
});

test('signing failure or cancellation is not_sent, uses fixed errors, and does not retry same action', async () => {
  for (const cancel of [false, true]) {
    const f = fixture(); f.generate(() => { if (cancel) f.controller.abort(); throw Error('private upstream token and body'); });
    const result = await f.run(); assert.equal(result.status, 'not_sent'); assert.equal(result.error, cancel ? 'cancelled' : 'unsupported');
    assert.equal(f.sent.length, 0); assert.ok(!JSON.stringify(result).includes('private')); if (!cancel) assert.equal((await f.run()).duplicate, true);
  }
  const f = fixture(); f.controller.abort(); assert.equal((await f.run()).error, 'cancelled'); assert.equal(f.files.size, 0);
});

test('every ambiguous post-dispatch error and invalid message ID stays uncertain across restart', async () => {
  for (const mode of ['failed', 'timeout', 'cancel', 'disconnect', 'missing-id', 'zero-id']) {
    const f = fixture(); f.send(() => {
      if (mode === 'missing-id') return undefined as any;
      if (mode === 'zero-id') return '0';
      if (mode === 'cancel') f.controller.abort();
      throw new QQError(mode === 'failed' ? 'platform_failed' : mode, 'do not expose private body');
    });
    const result = await f.run(); assert.equal(result.status, 'uncertain', mode); assert.equal(result.error, 'uncertain');
    assert.equal(result.canRetry, false); assert.equal(f.sent.length, 1); f.reload();
    if (mode !== 'cancel') { assert.equal((await f.run()).status, 'uncertain'); assert.equal(f.sent.length, 1); }
  }
});

test('persistent pending is uncertain after restart; explicit pre-dispatch OneBot rejection is not_sent', async () => {
  const f = fixture(); f.send(() => { throw new QQError('offline', 'fixed offline', true); });
  assert.equal((await f.run()).status, 'not_sent');
  const entry = [...f.files.entries()][0]; f.files.set(entry[0], { ...(entry[1] as any), state: 'pending', error: undefined });
  f.reload(); const result = await f.run(); assert.equal(result.status, 'uncertain'); assert.equal(result.duplicate, true); assert.equal(f.sent.length, 1);
});

test('storage failures fail closed and post-confirmation failure still reports platform truth', async () => {
  for (const stage of ['initial', 'pending', 'sent']) {
    const f = fixture(); f.save(value => { if (value.state === (stage === 'initial' ? 'not_sent' : stage)) throw Error('private disk error'); });
    const result = await f.run();
    assert.equal(result.status, stage === 'sent' ? 'sent' : 'not_sent');
    assert.equal(f.sent.length, stage === 'sent' ? 1 : 0);
    if (stage === 'sent') {
      assert.equal(result.confirmed, true); assert.equal(result.ledgerSaved, false); assert.equal(result.error, 'storage');
      assert.equal((await f.run()).status, 'sent'); assert.equal(f.sent.length, 1);
      f.reload(); assert.equal((await f.run()).status, 'uncertain'); assert.equal(f.sent.length, 1);
    }
  }
});

test('corrupt ledger is preserved and blocks generation; session/guard changes after signing block dispatch', async () => {
  const f = fixture(); await f.run(); const file = [...f.files.keys()][0]; f.files.set(file, ['invalid']); f.reload();
  assert.equal((await f.run()).error, 'storage'); assert.equal((await f.status()).status, 'uncertain'); assert.deepEqual(f.files.get(file), ['invalid']); assert.equal(f.generated.length, 1);
  for (const change of ['session', 'binding']) {
    const g = fixture(); let generated = false;
    g.generate(() => { generated = true; if (change === 'session') g.session(() => { throw Error('gone'); }); return { data: ark() }; });
    const result = await g.run({}, { permission: 'full' }, async () => { if (generated && change === 'binding') throw new QQError('binding', 'fixed conflict'); });
    assert.equal(result.error, change); assert.equal(result.status, 'not_sent'); assert.equal(g.sent.length, 0);
  }
});

test('cancel immediately after confirmed receipt does not erase the fact or cause another send', async () => {
  const f = fixture(); f.send(() => { f.controller.abort(); return '9009'; });
  const result = await f.run(); assert.equal(result.status, 'sent'); assert.equal(result.platformMessageId, '9009'); assert.equal(result.confirmed, true);
});

test('invalid cards and failed persistence leave input open; confirmed delivery seals it only once', async () => {
  for (const failure of ['signature', 'storage', 'none']) {
    const f = fixture(); let closed = 0;
    if (failure === 'signature') f.generate(() => ({ data: {} }));
    if (failure === 'storage') f.save(value => { if (value.state === 'pending') throw Error('synthetic disk failure'); });
    const close = async () => {
      assert.equal(f.generated.length, 1); assert.equal(f.sent.length, 0);
      assert.ok([...f.files.values()].some((v: any) => v.state === 'pending'));
      closed++;
    };
    const result = await f.run({}, { permission: 'full' }, async () => {}, close);
    assert.equal(result.status, failure === 'none' ? 'sent' : 'not_sent');
    assert.equal(closed, failure === 'none' ? 1 : 0);
    assert.equal((await f.run({}, { permission: 'full' }, async () => {}, close)).duplicate, true);
    assert.equal(closed, failure === 'none' ? 1 : 0);
  }
});

test('native QQ share links preserve the signed payload and validate the video URL and displayed title', async () => {
  for (const scheme of ['', 'https://']) {
    const f = fixture(), value = nativeArk(); value.meta.detail_1.url = scheme + value.meta.detail_1.url;
    f.generate(() => ({ data: value }));
    assert.equal((await f.run()).status, 'sent');
    assert.deepEqual(JSON.parse(f.sent[0]), value);
    assert.equal((await f.run()).duplicate, true); assert.equal(f.sent.length, 1);
  }
  for (const patch of [
    { qqdocurl: 'https://www.bilibili.com/video/BV17x411w7KC/' }, { qqdocurl: undefined },
    { qqdocurl: input.webUrl + '?other=1' }, { desc: 'Different video title' },
    { url: 'https://m.q.qq.com.evil.invalid/a/s/' + 'a'.repeat(32) },
    { url: 'https://m.q.qq.com/a/s/' + 'a'.repeat(32) + '?redirect=evil' },
    { url: 'http://m.q.qq.com/a/s/' + 'a'.repeat(32) },
    { url: 'm.q.qq.com/a/s/not-a-signed-link' },
    { url: input.jumpPath, qqdocurl: 'https://www.bilibili.com/video/BV17x411w7KC/' },
  ]) {
    const f = fixture(), value = nativeArk(); Object.assign(value.meta.detail_1, patch);
    f.generate(() => ({ data: value }));
    assert.equal((await f.run()).error, 'invalid_card'); assert.equal(f.sent.length, 0);
  }
});

test('PC-generated Bilibili cards retain signed content and use the native mobile Open App scene', async () => {
  for (const scene of [0, 1036]) {
    const f = fixture(), source = nativeArk();
    source.meta.detail_1.scene = scene;
    const before = structuredClone(source);
    f.generate(() => ({ data: source }));
    assert.equal((await f.run()).status, 'sent');
    const delivered = JSON.parse(f.sent[0]);
    // The official Bilibili mini-app enables its QQ Open App control only
    // for these launch scenes; the PC response's zero does not enable it.
    assert.ok(['1036', '1069', '2003'].includes(String(delivered.meta.detail_1.scene)));
    assert.equal(delivered.meta.detail_1.scene, 1036);
    delivered.meta.detail_1.scene = scene;
    assert.deepEqual(delivered, before, 'all signed content and unknown fields remain intact');
    assert.deepEqual(source, before, 'do not mutate the protocol response');
    f.reload(); assert.equal((await f.run()).duplicate, true);
    assert.equal(f.sent.length, 1, 'a new presentation does not replay existing delivery');
  }
});
