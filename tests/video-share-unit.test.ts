/*! Copyright (c) 2026 iinukami and contributors.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import sharp from 'sharp';
import type { Context } from 'whalelife';
import { defaults, QQError } from '../src/config.ts';
import { OutboundMiniApp, type MiniAppShare } from '../src/outbound-miniapp.ts';
import { prepareVideoCard, type PreparedVideoCard, type ShareMessage, type VideoShareFormat } from '../src/video-share.ts';

const input: MiniAppShare = { userId: '200002', actionId: 'bilibili:video-unit', sessionId: 'session-a', personaId: 'a',
  preset: 'bili', title: 'Synthetic private video title。第二句。', description: 'Synthetic private description',
  previewUrl: 'https://i0.hdslb.com/bfs/archive/synthetic-video-cover.png', jumpPath: 'pages/video/video?avid=123456',
  webUrl: 'https://www.bilibili.com/video/BV1GJ411x7h7/' };
const expectedText = [input.title, input.description, input.webUrl].join('\n');
const textCard: PreparedVideoCard = { coverIncluded: false, message: [{ type: 'text', data: { text: expectedText } }] };
const coveredCard: PreparedVideoCard = { coverIncluded: true,
  message: [{ type: 'image', data: { file: 'base64://synthetic-private-cover-bytes', sub_type: 0 } }, ...textCard.message] };
const imageResponse = (bytes: Uint8Array, headers: Record<string, string> = {}) => new Response(new Uint8Array(bytes),
  { headers: { 'content-type': 'image/png', ...headers } });

function fixture() {
  const files = new Map<string, any>(), experiences: any[] = [], generated: any[] = [];
  const cards: ShareMessage[] = [], miniapps: string[] = [];
  const config = { ...defaults, accountId: '100001', allowedUsers: ['200002'], personaId: 'a', permission: 'full' as const };
  let prepared = 0, closed = 0;
  let prepare = async (_value: MiniAppShare, _signal: AbortSignal) => structuredClone(coveredCard);
  let submit = async () => '9001';
  let beforePending = async () => {};
  let saveHook = (_value: any) => {};
  const ctx = { config: {
    read: async (name: string) => structuredClone(files.get(name) ?? {}),
    save: async (name: string, value: any) => { saveHook(value); files.set(name, structuredClone(value)); },
  }, sessions: {
    list: async () => [{ id: input.sessionId }],
    context: async (session: string, persona: string) => { assert.equal(session, input.sessionId); assert.equal(persona, 'a'); return {}; },
  }, memory: { recordExperience: async (_session: string, value: any) => { experiences.push(value); } } } as unknown as Context;
  const create = () => new OutboundMiniApp(ctx, config, async params => {
    generated.push(params);
    return { data: { app: 'com.tencent.miniapp_01', config: { token: 'synthetic-private-signature' },
      meta: { detail_1: { appid: '1109937557', url: input.jumpPath } } } };
  }, async (_user, payload, _signal, pending, dispatched) => {
    await pending(); dispatched(); miniapps.push(payload); return '9002';
  }, { prepare: async (value, signal) => { prepared++; return prepare(value, signal); },
    submit: async (user, message, _signal, pending, dispatched) => {
      assert.equal(user, input.userId); await beforePending(); await pending(); dispatched();
      cards.push(structuredClone(message)); return submit();
    } });
  const controller = new AbortController(); let service = create();
  return { files, experiences, generated, cards, miniapps, config, controller,
    prepared: () => prepared, closed: () => closed,
    run: (format: VideoShareFormat = 'card', patch: Partial<MiniAppShare> = {}, includeFormat = true, options: any = { permission: 'full' }) =>
      service.execute({ ...input, ...patch }, options, controller.signal, async () => {}, async () => { closed++; }, format, includeFormat),
    status: (includeFormat = true) => service.status({ userId: input.userId, actionId: input.actionId, sessionId: input.sessionId }, controller.signal, includeFormat),
    reload: () => { service = create(); },
    prepare: (hook: typeof prepare) => { prepare = hook; }, submit: (hook: typeof submit) => { submit = hook; },
    beforePending: (hook: typeof beforePending) => { beforePending = hook; }, save: (hook: typeof saveHook) => { saveHook = hook; },
  };
}

test('video card without a cover performs no fetch and keeps one complete visible URL', async () => {
  let fetched = false;
  const result = await prepareVideoCard({ ...input, previewUrl: '' }, defaults, new AbortController().signal,
    async () => { fetched = true; throw Error('unexpected network'); });
  assert.equal(fetched, false); assert.deepEqual(result, textCard);
  assert.equal(expectedText.split(input.webUrl).length - 1, 1);
});

test('video cover becomes bounded inline JPEG plus an unchanged single text segment', async () => {
  const png = await sharp({ create: { width: 1600, height: 800, channels: 3, background: '#446688' } }).png().toBuffer();
  const calls: Array<{ url: string; options?: RequestInit }> = [];
  const result = await prepareVideoCard(input, defaults, new AbortController().signal, async (url, options) => {
    calls.push({ url: String(url), options }); return imageResponse(png);
  });
  assert.equal(result.coverIncluded, true); assert.equal(result.message.length, 2);
  assert.deepEqual(result.message[1], textCard.message[0]);
  const image = result.message[0]; assert.equal(image.type, 'image');
  if (image.type !== 'image') throw Error('missing cover');
  assert.equal(image.data.sub_type, 0); assert.ok(image.data.file.startsWith('base64://'));
  const decoded = Buffer.from(image.data.file.slice(9), 'base64'), metadata = await sharp(decoded).metadata();
  assert.equal(metadata.format, 'jpeg'); assert.equal(metadata.width, 1280); assert.equal(metadata.height, 640);
  assert.equal(calls.length, 1); assert.equal(calls[0].url, input.previewUrl);
  assert.equal(calls[0].options?.redirect, 'error'); assert.equal(calls[0].options?.headers, undefined);
});

test('cover download, MIME, decoding and byte-limit failures only remove the optional cover', async () => {
  const png = await sharp({ create: { width: 2, height: 2, channels: 3, background: 'white' } }).png().toBuffer();
  const cases: Array<() => Promise<Response>> = [
    async () => { throw Error('private network URL and token'); },
    async () => new Response('private upstream body', { status: 403 }),
    async () => imageResponse(png, { 'content-type': 'text/html' }),
    async () => imageResponse(new Uint8Array()),
    async () => imageResponse(Buffer.from('not an image, private upstream body')),
    async () => imageResponse(png, { 'content-length': '1025' }),
    async () => imageResponse(new Uint8Array(1025)),
  ];
  for (const fetcher of cases) {
    const result = await prepareVideoCard(input, { ...defaults, maxMediaBytes: 1024 }, new AbortController().signal, fetcher);
    assert.deepEqual(result, textCard); assert.ok(!JSON.stringify(result).includes('private upstream'));
  }
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new Uint8Array(1025)); }, cancel() { cancelled = true; },
  });
  assert.deepEqual(await prepareVideoCard(input, { ...defaults, maxMediaBytes: 1024 }, new AbortController().signal,
    async () => new Response(stream, { headers: { 'content-type': 'image/png' } })), textCard);
  assert.equal(cancelled, true);
});

test('untrusted cover URLs never fetch and cancellation never degrades into a sendable text card', async () => {
  for (const previewUrl of ['http://i0.hdslb.com/x', 'https://hdslb.com.evil.invalid/x', 'https://u:p@i0.hdslb.com/x',
    'https://i0.hdslb.com:8443/x', 'https://i0.hdslb.com/x#fragment', 'file:///private.png']) {
    let called = false;
    assert.deepEqual(await prepareVideoCard({ ...input, previewUrl }, defaults, new AbortController().signal,
      async () => { called = true; throw Error('must not fetch'); }), textCard);
    assert.equal(called, false, previewUrl);
  }
  for (const alreadyAborted of [false, true]) {
    const controller = new AbortController(); let calls = 0;
    if (alreadyAborted) controller.abort();
    await assert.rejects(prepareVideoCard(input, defaults, controller.signal, async () => {
      calls++; controller.abort(); throw Error('download aborted');
    }), { name: 'AbortError' });
    assert.equal(calls, alreadyAborted ? 0 : 1);
  }
});

test('card delivery bypasses signing, sends one message, records only a fixed fact and survives reload', async () => {
  const f = fixture(); assert.equal((await f.status()).status, 'not_found');
  const result = await f.run();
  assert.deepEqual(result, { status: 'sent', confirmed: true, duplicate: false, retryAutomatically: false,
    canRetry: false, ledgerSaved: true, platformMessageId: '9001', format: 'card', coverIncluded: true });
  assert.deepEqual(f.cards, [coveredCard.message]); assert.equal(f.generated.length, 0); assert.equal(f.miniapps.length, 0);
  assert.equal(f.closed(), 1); assert.equal((await f.run()).duplicate, true);
  f.reload(); assert.equal((await f.run()).duplicate, true); assert.equal((await f.status()).format, 'card');
  assert.equal(f.cards.length, 1); assert.equal(f.prepared(), 1); assert.equal(f.experiences.length, 1);
  assert.equal(f.experiences[0].text, '已通过 QQ 私聊分享一个 B 站视频链接。');
  const durable = JSON.stringify([...f.files, ...f.experiences]);
  for (const privateValue of [input.title, input.description, input.previewUrl, input.webUrl, input.jumpPath,
    input.userId, input.sessionId, 'synthetic-private-cover-bytes', 'synthetic-private-signature'])
    assert.ok(!durable.includes(privateValue), privateValue);
});

test('cover failure degrades once before dispatch, never after failed or ambiguous delivery', async () => {
  const f = fixture(); let fetches = 0;
  f.prepare((value, signal) => prepareVideoCard(value, defaults, signal, async () => { fetches++; throw Error('cover offline'); }));
  assert.equal((await f.run()).coverIncluded, false); assert.deepEqual(f.cards, [textCard.message]);
  assert.equal(fetches, 1); assert.equal(f.generated.length, 0);
  for (const mode of ['platform_failed', 'timeout', 'disconnect', 'missing-id']) {
    const g = fixture(); g.submit(async () => { if (mode === 'missing-id') return ''; throw new QQError(mode, 'private error'); });
    const result = await g.run(); assert.equal(result.status, 'uncertain', mode); assert.equal(result.coverIncluded, true);
    assert.equal(result.retryAutomatically, false); assert.equal(result.canRetry, false);
    g.reload(); assert.equal((await g.run()).duplicate, true); assert.equal((await g.status()).status, 'uncertain');
    assert.equal(g.cards.length, 1); assert.equal(g.prepared(), 1); assert.equal(g.generated.length, 0);
    assert.deepEqual(g.cards[0], coveredCard.message); assert.ok(!JSON.stringify(result).includes('private'));
  }
});

test('card cancellation before preparation, during preparation or in the shared queue sends nothing', async () => {
  for (const stage of ['before', 'prepare', 'queued']) {
    const f = fixture();
    if (stage === 'before') f.controller.abort();
    if (stage === 'prepare') f.prepare(async () => { f.controller.abort(); return coveredCard; });
    if (stage === 'queued') f.beforePending(async () => { f.controller.abort(); });
    const result = await f.run(); assert.equal(result.status, 'not_sent', stage); assert.equal(result.error, 'cancelled');
    assert.equal(f.cards.length, 0); assert.equal(f.miniapps.length, 0); assert.equal(f.generated.length, 0); assert.equal(f.closed(), 0);
  }
});

test('card mode keeps permission and target validation; only it permits an empty cover URL', async () => {
  for (const [patch, options] of [
    [{ userId: '300003' }, { permission: 'full' }], [{ userId: '100001' }, { permission: 'full' }],
    [{ sessionId: 'missing-session' }, { permission: 'full' }], [{ rawArkData: '{}' }, { permission: 'full' }],
    [{ previewUrl: 'https://example.com/private.png' }, { permission: 'full' }],
    [{ webUrl: input.webUrl + '?secret=private' }, { permission: 'full' }], [{}, { permission: 'safe' }],
  ] as const) {
    const f = fixture(); assert.equal((await f.run('card', patch as any, true, options)).status, 'not_sent');
    assert.equal(f.prepared(), 0); assert.equal(f.cards.length, 0); assert.equal(f.generated.length, 0);
  }
  const f = fixture(); f.prepare((value, signal) => prepareVideoCard(value, defaults, signal, async () => { throw Error('no fetch'); }));
  assert.equal((await f.run('card', { previewUrl: '' })).status, 'sent'); assert.deepEqual(f.cards, [textCard.message]);
  const g = fixture(); assert.equal((await g.run('miniapp', { previewUrl: '' }, false)).error, 'invalid_input');
  assert.equal(g.generated.length, 0);
});

test('formats share one action ledger and legacy receipts never acquire video-only fields', async () => {
  for (const first of ['card', 'miniapp'] as const) {
    const f = fixture(), other = first === 'card' ? 'miniapp' : 'card';
    assert.equal((await f.run(first)).status, 'sent'); f.reload();
    assert.equal((await f.run(other)).error, 'conflict');
    assert.equal((await f.run(first, { title: 'changed title' })).error, 'conflict');
    assert.equal(f.cards.length + f.miniapps.length, 1); assert.equal(f.files.size, 1);
    assert.equal((await f.status()).format, first);
    const legacy = await f.status(false);
    assert.equal(legacy.error, first === 'card' ? 'conflict' : undefined);
    assert.equal(Object.hasOwn(legacy, 'format'), false); assert.equal(Object.hasOwn(legacy, 'coverIncluded'), false);
    if (first === 'miniapp') {
      const old = await f.run('miniapp', {}, false); assert.equal(old.duplicate, true);
      assert.equal(Object.hasOwn(old, 'format'), false); assert.equal(Object.hasOwn(old, 'coverIncluded'), false);
    }
  }
});

test('pre-upgrade ledgers without format are miniapp receipts and block cross-format replay', async () => {
  const f = fixture(), hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
  // Construct the old persisted schema independently, rather than deleting a new field.
  const key = hash([f.config.accountId, input.sessionId, input.userId, input.actionId]);
  f.files.set(`miniapp-delivery-${key}.json`, { version: 1, key,
    fingerprint: hash([input.personaId, input.preset, input.title, input.description, input.previewUrl, input.jumpPath, input.webUrl]),
    state: 'sent', platformMessageId: '8777' });
  const found = await f.status(); assert.equal(found.status, 'sent'); assert.equal(found.format, 'miniapp');
  assert.equal((await f.run('miniapp')).duplicate, true); assert.equal((await f.run('card')).error, 'conflict');
  assert.equal((await f.run('miniapp', {}, false)).platformMessageId, '8777');
  assert.equal(f.generated.length, 0); assert.equal(f.prepared(), 0); assert.equal(f.cards.length, 0);
});

test('pending and corrupt card ledgers fail closed, while confirmed delivery survives storage failure', async () => {
  for (const stage of ['not_sent', 'pending', 'sent']) {
    const f = fixture(); f.save(value => { if (value.state === stage) throw Error('private disk error'); });
    const result = await f.run(); assert.equal(result.status, stage === 'sent' ? 'sent' : 'not_sent');
    assert.equal(f.cards.length, stage === 'sent' ? 1 : 0);
    if (stage === 'sent') {
      assert.equal(result.confirmed, true); assert.equal(result.ledgerSaved, false); assert.equal(result.coverIncluded, true);
      f.reload(); assert.equal((await f.run()).status, 'uncertain'); assert.equal(f.cards.length, 1);
    }
  }
  const f = fixture(); await f.run();
  const name = [...f.files.keys()][0], value = f.files.get(name);
  f.files.set(name, { ...value, coverIncluded: 'wrong' }); f.reload();
  assert.equal((await f.status()).error, 'storage'); assert.equal((await f.run()).error, 'storage');
  assert.equal(f.cards.length, 1); assert.equal(f.files.get(name).coverIncluded, 'wrong');
});
