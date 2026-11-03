import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { setTimeout as sleep } from 'node:timers/promises';
import { WebSocketServer, type WebSocket } from 'ws';
import { OneBot, type LinkState } from '../src/onebot.ts';
import { defaults } from '../src/config.ts';

async function until(check: () => boolean) {
  for (let i = 0; i < 250; i++) { if (check()) return; await sleep(10); }
  assert.fail('condition timed out');
}
async function transport(t: TestContext, mode: 'attach' | 'external' = 'attach', initiallyOffline = true, wrongAccount = false) {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const controller = new AbortController(), states: LinkState[] = [], calls: string[] = [], events: unknown[] = [];
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  let bot: OneBot | undefined, socket: WebSocket | undefined, offline = initiallyOffline, hold = false;
  t.after(async () => {
    controller.abort(); bot?.stop();
    for (const client of server.clients) client.terminate();
    await new Promise<void>(resolve => server.close(() => resolve()));
  });
  await once(server, 'listening');
  server.on('connection', client => {
    socket = client;
    client.on('message', bytes => {
      const data = JSON.parse(bytes.toString()); calls.push(data.action);
      if (hold && data.action === 'get_friend_list') return;
      const fail = offline && data.action !== 'get_login_info';
      client.send(JSON.stringify({ echo: data.echo, status: fail ? 'failed' : 'ok', retcode: fail ? 1200 : 0,
        message: fail ? 'selected_account_offline' : '', wording: fail ? 'PRIVATE-TEXT Bearer secret https://private/path' : '',
        data: data.action === 'get_login_info' ? { user_id: wrongAccount ? 100002 : 100001 } : data.action === 'get_friend_list' ? [] : { message_id: 9876 } }));
    });
  });
  bot = new OneBot({ ...defaults, connectionMode: mode, accountId: '100001', requestTimeoutMs: 60000,
    wsUrl: `ws://127.0.0.1:${(server.address() as { port: number }).port}/` }, controller.signal, e => events.push(e), s => states.push(s));
  bot.start();
  await until(() => states.some(s => ['online', 'disconnected', 'stopped'].includes(s.state)));
  return { bot, calls, states, events, controller, state: () => states.at(-1)!, setOffline: (v: boolean) => { offline = v; },
    setHold: (v: boolean) => { hold = v; }, event: () => socket!.send(JSON.stringify({ post_type: 'message', message_type: 'private' })),
    async tick() { t.mock.timers.tick(15000); await sleep(30); } };
}

test('native health overrides cached login; recovery restores traffic without replaying failed sends', async t => {
  const f = await transport(t);
  assert.equal(f.state().state, 'disconnected'); assert.match(f.state().error!, /接入不可用/);
  assert.deepEqual(f.calls, ['get_login_info', 'get_friend_list']);
  f.event(); await sleep(20); assert.equal(f.events.length, 0);
  await assert.rejects(f.bot.request('send_private_msg', {}, f.controller.signal), /尚未连接/);
  f.setOffline(false); await f.tick(); await until(() => f.state().state === 'online');
  f.event(); await until(() => f.events.length === 1);
  assert.equal((await f.bot.request('send_private_msg', {}, f.controller.signal)).message_id, 9876);
  f.setOffline(true);
  await assert.rejects(f.bot.request('send_private_msg', {}, f.controller.signal), /接入不可用.*1200/);
  assert.equal(f.state().state, 'disconnected');
  f.setOffline(false); await f.tick(); await until(() => f.state().state === 'online');
  assert.equal(f.calls.filter(a => a === 'send_private_msg').length, 2);
  assert.ok(!JSON.stringify(f.states).includes('PRIVATE-TEXT'));
});

test('health checks detect idle offline state, are serialized, and stop with the plugin', async t => {
  const f = await transport(t, 'attach', false);
  f.setOffline(true); await f.tick(); await until(() => f.state().state === 'disconnected');
  f.setOffline(false); await f.tick(); await until(() => f.state().state === 'online');
  f.setHold(true); await f.tick(); const count = f.calls.length;
  await f.tick(); assert.equal(f.calls.length, count);
  f.controller.abort(); assert.equal(f.state().state, 'stopped');
  await f.tick(); assert.equal(f.calls.length, count); assert.equal(f.state().state, 'stopped');
});

test('external protocol keeps its existing handshake and exposes only bounded error codes', async t => {
  const f = await transport(t, 'external');
  assert.equal(f.state().state, 'online'); assert.deepEqual(f.calls, ['get_login_info']);
  await assert.rejects(f.bot.request('send_private_msg', {}, f.controller.signal), (e: any) => {
    assert.equal(e.code, 'platform_failed'); assert.match(e.message, /1200/); assert.equal(e.notSent, false);
    assert.ok(!e.message.includes('PRIVATE-TEXT')); assert.ok(!e.message.includes('secret')); return true;
  });
  await f.tick(); assert.ok(!f.calls.includes('get_friend_list'));
});

test('only pre-submit refusal and the bundled plain-text native guard prove no send', async t => {
  const f = await transport(t, 'attach', false);
  f.setOffline(true);
  const params = { auto_escape: true, message: [{ type: 'text', data: { text: 'test' } }] };
  await assert.rejects(f.bot.request('send_private_msg', params, f.controller.signal), (e: any) => e.notSent === true);
  const before = f.calls.length;
  await assert.rejects(f.bot.request('send_private_msg', params, f.controller.signal), (e: any) => e.notSent === true);
  assert.equal(f.calls.length, before);
  f.setOffline(false); await f.tick(); await until(() => f.state().state === 'online'); f.setOffline(true);
  await assert.rejects(f.bot.request('send_private_msg', { message: [{ type: 'image' }] }, f.controller.signal), (e: any) => e.notSent === false);
});

test('wrong login identity remains stopped and never starts native health or business actions', async t => {
  const f = await transport(t, 'attach', false, true);
  assert.equal(f.state().state, 'stopped'); assert.match(f.state().error!, /账号与配置不符/);
  await f.tick(); assert.deepEqual(f.calls, ['get_login_info']);
});
