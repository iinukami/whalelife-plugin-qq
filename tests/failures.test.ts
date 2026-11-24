import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createConnection } from 'node:net';
import type { Duplex } from 'node:stream';
import { once } from 'node:events';
import sharp from 'sharp';
import { activePersonaMinimum, baselineBoot } from './host-baseline.ts';
import { fixture, until } from './fixture.ts';

test('account mismatch stops permanently and never receives or sends for the wrong account', { timeout: 15000 }, async t => {
  const f = await fixture(t, { config: { accountId: '100009' } });
  await until(async () => (await f.status()).state === 'stopped');
  assert.match((await f.status()).error, /账号与配置不符/);
  await new Promise(r => setTimeout(r, 1200));
  assert.equal(f.connects(), 1); assert.equal(f.generations.length, 0);
});

test('multipart delivery reports asynchronous acknowledgment as uncertain; successful earlier parts are not resent', { timeout: 20000 }, async t => {
  const f = await fixture(t); await f.online();
  f.setGenerate(async () => ({ text: '🙂'.repeat(3100), toolCalls: [] }));
  let sends = 0;
  f.setAction((data, socket) => {
    if (data.action !== 'send_private_msg') return false;
    sends++;
    assert.equal(data.params.message[0].type, 'text');
    assert.ok(Array.from(data.params.message[0].data.text).length <= 1500);
    socket.send(JSON.stringify({ echo: data.echo, status: sends < 3 ? 'ok' : 'async', retcode: sends < 3 ? 0 : 1, data: sends < 3 ? { message_id: sends + 7000 } : {} }));
    return true;
  });
  f.send(); await until(async () => (await f.status()).recent.some((n: any) => n.status === 'delivery_failed'));
  assert.equal(sends, 3); f.send();
  await new Promise(r => setTimeout(r, 100)); assert.equal(sends, 3); assert.equal(f.generations.length, 1);
  assert.equal(await f.app.runtime.services.get('witness')!.value.ping(), 'alive');
});

test('platform failure and protocol timeout are contained, and new messages can recover', { timeout: 20000 }, async t => {
  const f = await fixture(t); await f.online(); let mode = 'fail';
  f.setAction((data, socket) => {
    if (data.action !== 'send_private_msg') return false;
    if (mode === 'fail') socket.send(JSON.stringify({ echo: data.echo, status: 'failed', retcode: 100, data: null, message: 'SECRET-MUST-NOT-LEAK' }));
    return mode !== 'ok';
  });
  f.send(); await until(async () => (await f.status()).recent.some((n: any) => n.messageId === '1' && n.status === 'delivery_failed'));
  mode = 'timeout'; f.send({ message_id: 2 });
  await until(async () => (await f.status()).recent.some((n: any) => n.messageId === '2' && n.status === 'delivery_failed'));
  mode = 'ok'; f.send({ message_id: 3 });
  await until(async () => (await f.status()).recent.some((n: any) => n.messageId === '3' && n.status === 'sent'));
  assert.equal(f.generations.length, 3); assert.equal(f.app.runtime.records.get('qq')?.status, 'active');
  assert.ok(!JSON.stringify(await f.status()).includes('SECRET-MUST-NOT-LEAK'));
});

test('connection switch cancels pending platform acknowledgment and stops reconnect timers', { timeout: 20000 }, async t => {
  const f = await fixture(t); await f.online();
  f.setAction(data => data.action === 'send_private_msg');
  f.send(); await until(() => f.calls.some(c => c.action === 'send_private_msg'));
  const connections = f.connects();
  assert.equal((await f.save({ enabled: false })).status, 200);
  await new Promise(r => setTimeout(r, 1200));
  assert.equal(f.connects(), connections); assert.equal((await f.status()).state, 'disabled');
  assert.equal(f.app.runtime.records.get('qq')?.status, 'active');
});

test('the auxiliary vision model on a text-only host uses its proxy and cancels hanging HTTP', { timeout: 25000 }, async t => {
  const proxy = createServer(); let tunnels = 0; const sockets = new Set<Duplex>();
  proxy.on('connect', (req, client, head) => {
    tunnels++; const target = new URL('http://' + req.url!);
    const upstream = createConnection({ host: target.hostname, port: Number(target.port) }, () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) upstream.write(head); client.pipe(upstream); upstream.pipe(client);
    });
    sockets.add(client); sockets.add(upstream);
    client.on('error', () => upstream.destroy()); upstream.on('error', () => client.destroy());
    client.on('close', () => { sockets.delete(client); upstream.destroy(); }); upstream.on('close', () => sockets.delete(upstream));
  });
  t.after(async () => { for (const s of sockets) s.destroy(); await new Promise<void>(r => proxy.close(() => r())); });
  proxy.listen(0, '127.0.0.1'); await once(proxy, 'listening');
  const f = await fixture(t, { hostBoot: await baselineBoot(activePersonaMinimum), proxy: `http://127.0.0.1:${(proxy.address() as { port: number }).port}`, modelTimeout: 1 }); await f.online();
  const png = await sharp({ create: { width: 2, height: 2, channels: 3, background: 'blue' } }).png().toBuffer();
  const message = [{ type: 'image', data: { url: 'base64://' + png.toString('base64') } }];
  f.send({ message }); await until(() => f.generations.length === 1);
  assert.ok(tunnels > 0); assert.equal(f.modelCalls.length, 1);
  let closed = false;
  f.setModelHandler((_req, res) => { res.on('close', () => { closed = true; }); });
  f.send({ message_id: 2, message });
  await until(async () => (await f.status()).recent.some((n: any) => n.messageId === '2' && n.status === 'failed'));
  await until(() => closed); assert.equal(f.generations.length, 1);
});

test('cross-peer quote expansion and unapproved media hosts are rejected without leaking context or fetching bytes', { timeout: 20000 }, async t => {
  const f = await fixture(t, { config: { mediaHosts: ['qq.com'] } }); await f.online();
  f.setAction((data, socket) => {
    if (data.action !== 'get_msg') return false;
    socket.send(JSON.stringify({ echo: data.echo, status: 'ok', retcode: 0, data: { message_type: 'private', sender: { user_id: 999999 }, message: [{ type: 'text', data: { text: 'PRIVATE-OTHER-PEER' } }] } })); return true;
  });
  f.send({ message: [{ type: 'reply', data: { id: 77 } }, { type: 'text', data: { text: '看看引用' } }] });
  await until(() => f.generations.length === 1);
  assert.ok(!JSON.stringify(f.generations).includes('PRIVATE-OTHER-PEER'));
  f.send({ message_id: 2, message: [{ type: 'image', data: { url: f.modelUrl + '/private' } }] });
  await until(async () => (await f.status()).recent.some((n: any) => n.messageId === '2' && n.status === 'failed'));
  assert.equal(f.modelCalls.length, 0); assert.equal(f.generations.length, 1);
});
