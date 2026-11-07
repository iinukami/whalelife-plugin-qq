import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Response } from 'undici';
import { SpaceWebTransport } from '../src/space/web-transport.ts';
import { parseFeeds, parseProfileFeeds } from '../src/space/feeds.ts';
import { readVideoBytes, videoUrl, VIDEO_BYTES } from '../src/space/video.ts';

const url = 'https://photovideo.photo.qq.com/synthetic.f0.mp4?dis_k=SYNTHETIC_SIGNED_VALUE';
const mp4 = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypisom'), Buffer.alloc(20)]);
const webm = Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x87, 0x42, 0x82, 0x84, 0x77, 0x65, 0x62, 0x6d]);
const native = `<div class="img-box f-video-wrap play" url3="${url}"><a data-type="video" data-v_vidioswfurl="${url}" data-v_source_website=""></a><img src="https://qpic.cn/cover.jpg"></div>`;
const card = (body: string) => `<div id="feed_200002_311_0_1700000000_0_1" data-key="test_tid"><i name="feed_data" data-uin="200002" data-tid="1700000000" data-fkey="test_tid"></i><div class="f-info">SYNTHETIC_POST</div>${body}</div>`;
const raw = (body = native) => JSON.stringify({ code: 0, data: { main: { hasMoreFeeds: true, externparam: 'pagenum=2' }, data: [{ html: card(body) }] } });
const options = () => ({ signal: new AbortController().signal });
function fixture(body = native) {
  let identity = { accountId: '100001', online: true }, downloads = 0;
  const requests: any[] = [], life = new AbortController();
  let response = () => new Response(mp4, { headers: { 'content-type': 'video/mp4', 'content-length': String(mp4.length) } });
  const bot = { request: async () => ({ cookies: 'uin=o0100001; p_skey=SYNTHETIC_COOKIE;' }) } as any;
  const web = new SpaceWebTransport(bot, life.signal, () => identity, (async (u: string, init: any) => {
    requests.push({ url: String(u), init });
    if (String(u).startsWith('https://user.qzone.qq.com/')) return new Response(raw(body));
    downloads++; return response();
  }) as any);
  return { web, requests, life, setIdentity: (v: typeof identity) => { identity = v; },
    setResponse: (v: typeof response) => { response = v; }, downloads: () => downloads,
    browse: () => web.browse({ sessionId: 'trusted' }, options()) };
}

test('native feed/profile videos are deduplicated; covers, third-party players and arbitrary links are not sources', () => {
  const extra = `<video poster="${url}"><source src="${url.replace('synthetic.f0.mp4', 'second.webm')}"></video>
    <div class="f-video-wrap" url3="${url.replace('synthetic', 'thirdparty')}"><a data-type="video" data-v_source_website="thirdparty" data-v_vidioswfurl="${url}"></a></div>
    <a href="${url.replace('synthetic', 'link')}"></a><embed src="https://v.qq.com/player.html"></embed>`;
  const parsed = parseFeeds(raw(native + extra), '100001', 10).posts[0];
  assert.deepEqual(parsed.videos, [url, url.replace('synthetic.f0.mp4', 'second.webm')]);
  assert.equal(parsed.images.length, 1); assert.equal(parsed.hasVideo, true);
  const profile = JSON.stringify({ code: 0, data: { main: {}, friend_data: [{ html: card(native) }] } });
  assert.deepEqual(parseProfileFeeds(profile, '100001', 10, 0).posts[0].videos, [url]);
  const unsupported = parseFeeds(raw('<video src="https://v.qq.com/player.html" poster="https://qpic.cn/cover.jpg"></video>'), '100001', 10).posts[0];
  assert.equal(unsupported.hasVideo, true); assert.deepEqual(unsupported.videos, []);
  assert.deepEqual(parseFeeds(raw('<div>text only</div>'), '100001', 10).posts[0].videos, []);
  assert.equal(parseFeeds(raw(Array.from({ length: 10 }, (_, i) => `<video src="${url.replace('synthetic', 'clip' + i)}"></video>`).join('')), '100001', 10).posts[0].videos.length, 8);
});

test('video allowlist rejects other origins, players, local files and credentials', () => {
  assert.equal(videoUrl(url.replace('https:', 'http:')), url);
  assert.equal(videoUrl(url.replace('https:', '')), url);
  for (const invalid of ['file:///tmp/test.mp4', 'data:video/mp4;base64,AAAA', url.replace('photo.qq.com', 'photo.qq.com.evil.invalid'),
    url.replace('photovideo', 'qvideo'), url.replace('https://', 'https://user:pass@'), url.replace('.com/', '.com:8443/'),
    url.replace('.mp4', '.html'), url + '#part', url + 'x'.repeat(4096), url + '界'.repeat(600)]) assert.equal(videoUrl(invalid), undefined);
});

test('browse seals video sources; reads only selected bytes without cookies or redirects and preserves old references', async () => {
  const f = fixture(), result = await f.browse(), post = result.posts[0], input = { sessionId: 'trusted', ref: post.ref, index: 0 };
  assert.equal(post.videoCount, 1); assert.equal(post.hasVideo, true); assert.ok(post.ref.length <= 65536);
  for (const s of [url, 'SYNTHETIC_SIGNED_VALUE', 'SYNTHETIC_COOKIE']) assert.ok(!JSON.stringify(result).includes(s));
  const resolved = f.web.resolve(input, options()); assert.ok(!JSON.stringify(resolved).includes('videos'));
  const media = await f.web.readVideo(input, options());
  assert.deepEqual(media, { mime: 'video/mp4', base64: mp4.toString('base64') });
  const request = f.requests.at(-1); assert.equal(request.url, url); assert.equal(request.init.redirect, 'error');
  assert.equal(request.init.headers, undefined, 'signed media never receives platform cookies');
  const oldRef = (f.web as any).seal({ accountId: '100001', sessionId: 'trusted', expires: Date.now() + 60000, kind: 'post', post: resolved, images: [] });
  assert.deepEqual(f.web.resolve({ sessionId: 'trusted', ref: oldRef }, options()), resolved);
  await assert.rejects(f.web.readVideo({ ...input, ref: oldRef }, options()), /没有支持/);
  assert.equal(f.downloads(), 1);
});

test('session, account, expiry, kind and input validation all precede a video download', async t => {
  const f = fixture(), result = await f.browse(), input = { sessionId: 'trusted', ref: result.posts[0].ref, index: 0 };
  for (const patch of [{ sessionId: 'other' }, { ref: 'fake' }, { ref: result.cursor! }, { index: -1 }, { index: 8 }, { index: 0.5 }, { url }, { path: '/tmp/a' }])
    await assert.rejects(f.web.readVideo({ ...input, ...patch }, options()));
  f.setIdentity({ accountId: '100001', online: false }); await assert.rejects(f.web.readVideo(input, options()));
  f.setIdentity({ accountId: '300003', online: true }); await assert.rejects(f.web.readVideo(input, options()));
  f.setIdentity({ accountId: '100001', online: true });
  const now = Date.now(); t.mock.method(Date, 'now', () => now + 16 * 60000);
  await assert.rejects(f.web.readVideo(input, options())); assert.equal(f.downloads(), 0);
});

test('video reader validates MIME, magic, length and both declared and streamed limits', async () => {
  const read = (r: Response) => readVideoBytes(r, options().signal, () => {});
  const cancelledBeforeRead = new AbortController(); cancelledBeforeRead.abort();
  await assert.rejects(readVideoBytes(new Response(mp4), cancelledBeforeRead.signal, () => {}));
  assert.equal((await read(new Response(mp4))).mime, 'video/mp4');
  assert.equal((await read(new Response(webm, { headers: { 'content-type': 'video/webm' } }))).mime, 'video/webm');
  for (const response of [new Response('<html>login</html>'), new Response(mp4, { status: 206 }),
    new Response(mp4, { headers: { 'content-type': 'text/html' } }), new Response(mp4, { headers: { 'content-type': 'video/webm' } }),
    new Response(mp4, { headers: { 'content-length': String(mp4.length + 1) } }), new Response(mp4, { headers: { 'content-length': '-1' } }),
    new Response(mp4, { headers: { 'content-length': String(VIDEO_BYTES + 1) } })]) await assert.rejects(read(response));
  let cancelled = false, count = 0; const chunk = new Uint8Array(1024 * 1024);
  const stream = new ReadableStream({ pull(c) { count++; c.enqueue(chunk); }, cancel() { cancelled = true; } });
  await assert.rejects(read(new Response(stream as any)), /64 MiB/);
  assert.equal(cancelled, true); assert.ok(count <= 67, 'stream is stopped at the byte limit');
});

test('pending streams cancel promptly; account changes discard bytes and busy state is released', async () => {
  const f = fixture(), input = { sessionId: 'trusted', ref: (await f.browse()).posts[0].ref, index: 0 };
  let cancelled = false;
  f.setResponse(() => new Response(new ReadableStream({ cancel() { cancelled = true; } }) as any));
  const controller = new AbortController(), pending = f.web.readVideo(input, { signal: controller.signal });
  await assert.rejects(f.web.readVideo(input, options()), /正在读取/);
  controller.abort(); await assert.rejects(pending, /取消/); assert.equal(cancelled, true);
  f.setResponse(() => new Response(new ReadableStream({ start(c) { c.enqueue(mp4); f.setIdentity({ accountId: '300003', online: true }); c.close(); } }) as any));
  await assert.rejects(f.web.readVideo(input, options()), /账号或连接/);
  f.setIdentity({ accountId: '100001', online: true }); f.setResponse(() => new Response(mp4));
  assert.equal((await f.web.readVideo(input, options())).mime, 'video/mp4');
  f.setResponse(() => { throw Error('SYNTHETIC_SIGNED_VALUE'); });
  await assert.rejects(f.web.readVideo(input, options()), e => e instanceof Error && e.message === '视频下载失败，请检查连接或重新浏览。');
  f.life.abort(); await assert.rejects(f.web.readVideo(input, options()));
});

test('large image and video references stay in the existing reference size limit', async () => {
  const images = Array.from({ length: 8 }, (_, i) => `<img src="https://qpic.cn/${i}.jpg?x=${'x'.repeat(3900)}">`).join('');
  const videos = Array.from({ length: 8 }, (_, i) => `<video src="https://photovideo.photo.qq.com/${i}.mp4?x=${'x'.repeat(3900)}"></video>`).join('');
  const f = fixture(images + videos), p = (await f.browse()).posts[0];
  assert.ok(p.videoCount! > 0 && p.videoCount! < 8); assert.ok(p.ref.length <= 65536);
  assert.equal(f.web.referenceStatus({ sessionId: 'trusted', ref: p.ref }, options()).valid, true);
});
