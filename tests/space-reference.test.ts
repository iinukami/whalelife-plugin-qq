import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Response } from 'undici';
import { SpaceWebTransport } from '../src/space/web-transport.ts';

test('reference diagnostics classify causes without credentials, network requests or breaking old errors', async t => {
  const signal = new AbortController().signal, options = { signal };
  let identity = { accountId: '100001', online: true }, requests = 0;
  const bot = { request: async () => ({ cookies: 'uin=o0100001; p_skey=SYNTHETIC_KEY;' }) } as any;
  const html = '<div id="feed_200002_311_0_1700000000_0_1" data-key="test_tid"><i name="feed_data" data-uin="200002" data-tid="1700000000" data-fkey="test_tid"></i><div class="f-info">PRIVATE_POST</div></div>';
  const fetch = (async () => { requests++; return new Response(JSON.stringify({ code: 0, data: {
    main: { hasMoreFeeds: true, externparam: 'basetime=17&pagenum=2' }, data: [{ html }],
  } })); }) as any;
  const web = new SpaceWebTransport(bot, signal, () => identity, fetch);
  const result = await web.browse({ sessionId: 's' }, options);
  const input = { sessionId: 's', ref: result.posts[0].ref, expectedKind: 'post' as const };
  const valid = web.referenceStatus(input, options); assert.equal(valid.valid, true);
  const expect = (reason: string, value = input, transport = web) => {
    const status = transport.referenceStatus(value, options);
    assert.equal(status.valid, false); if (status.valid) throw Error('expected failure');
    assert.equal(status.reason, reason);
    for (const privateValue of ['PRIVATE_POST', 'SYNTHETIC_KEY', input.ref, 'test_tid']) assert.ok(!JSON.stringify(status).includes(privateValue));
    if (reason !== 'wrong_kind') assert.throws(() => transport.resolve(value, options), /动态引用已过期、账号已变化或不属于本会话，请重新浏览。/);
  };
  expect('invalid_reference', { ...input, ref: 'broken' });
  expect('unreadable_reference', { ...input, ref: 'x'.repeat(120) });
  expect('session_mismatch', { ...input, sessionId: 'other' });
  expect('wrong_kind', { ...input, ref: result.cursor! });
  identity = { ...identity, online: false }; expect('offline');
  identity = { accountId: '300003', online: true }; expect('account_changed');
  identity = { accountId: '100001', online: true };
  expect('unreadable_reference', input, new SpaceWebTransport(bot, signal, () => identity, fetch));
  assert.ok(valid.valid);
  let now = Date.now() + 16000; t.mock.method(Date, 'now', () => now);
  assert.equal(web.referenceStatus(input, options).valid, true, '16 seconds is not the 15 minute expiry');
  now = valid.expiresAt;
  expect('expired');
  const cancel = new AbortController(); cancel.abort();
  assert.throws(() => web.referenceStatus(input, { signal: cancel.signal }));
  assert.equal(requests, 1, 'diagnostics do not browse, fetch images or perform actions');
});
