import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fixture, until } from './fixture.ts';
import { segmentationDefaults } from '../src/config.ts';

type Fixture = Awaited<ReturnType<typeof fixture>>;
const secret = 'SYNTHETIC_PRIVATE_BROWSE_701';
const args = { userId: '200002', messageId: secret + '-action', text: secret + '。第二句。' };
const sends = (f: Fixture) => f.calls.filter(c => c.action === 'send_private_msg');
const tool = (name: string, input: unknown) => ({ text: '', toolCalls: [{ id: name, name, arguments: JSON.stringify(input) }] });
const call = (f: Fixture, id: string, input = args, transientContext = true, signal?: AbortSignal) =>
  f.app.tools.call('qq_send_message', input, { id, permission: 'full', transientContext, signal });
async function noPersistedBody(f: Fixture) {
  for (const dir of ['memory', 'logs', 'plugins/qq/data']) {
    for (const file of await readdir(join(f.root, dir), { recursive: true, withFileTypes: true })) {
      if (file.isFile()) assert.ok(!(await readFile(join(file.parentPath, file.name), 'utf8')).includes(secret), dir + '/' + file.name);
    }
  }
}

test('real transient browse -> model send preserves segmentation, receipts and privacy across reload', async t => {
  const f = await fixture(t, { config: { permission: 'full', segmentedReply: { ...segmentationDefaults, enabled: true, interval: '0,0' } },
    prepareHost: async root => {
      const path = join(root, 'config/config.json'), config = JSON.parse(await readFile(path, 'utf8'));
      config.log.level = 'debug'; await writeFile(path, JSON.stringify(config));
    } });
  await f.online(); const id = await f.app.sessions.current();
  const dir = join(f.root, 'plugins/transient-probe'); await mkdir(dir);
  await writeFile(join(dir, 'plugin.yaml'), 'id: transient-probe\nname: Probe\nversion: 1.0.0\ndescription: Test only\n');
  await writeFile(join(dir, 'index.ts'), `export function apply(ctx) {
    ctx.tools.registerTransient({ name: 'probe_browse', danger: 'safe', description: 'Test browse', schema: {},
      run: () => ({content: '${secret}', receipt: null}) });
    ctx.provide('transient-probe', {run: id => ctx.sessions.runTransient({sessionId:id, text:'synthetic wake', permission:'full'})});
  }`);
  await f.app.runtime.loadPath('transient-probe');
  let turn = 0;
  f.setGenerate(async input => {
    if (turn++ === 0) return tool('probe_browse', {});
    if (turn === 2) { assert.ok(JSON.stringify(input.messages).includes(secret)); return tool('qq_send_message', args); }
    const result = JSON.parse(input.messages.at(-1).content).result;
    assert.equal(result.confirmed, true); assert.equal(result.transient, true);
    assert.equal(result.delivery.sentParts, 2); assert.equal(result.text, undefined);
    return { text: secret, toolCalls: [] };
  });
  await f.app.runtime.services.get('transient-probe')!.value.run(id);
  assert.deepEqual(sends(f).map(c => c.params.message[0].data.text), [secret + '。', '第二句。']);
  const rows = await f.app.memory.readSession(id);
  assert.ok(rows.some((r: any) => r.type === 'channel_receipt' && r.status === 'sent'));
  assert.ok(f.app.logger.lines.some((line: string) => line.includes('[临时参数不记录]')));
  await noPersistedBody(f);
  const results = await Promise.all([call(f, id), call(f, id)]);
  assert.ok(results.every(r => r.result.duplicate && r.result.confirmed));
  await f.app.runtime.action('qq', 'reload'); await f.online();
  assert.equal((await call(f, id)).result.duplicate, true);
  await noPersistedBody(f);
  // Crossing the privacy boundary with the same ID must never create a second action.
  assert.equal((await call(f, id, args, false)).result.confirmed, false);
  assert.equal((await call(f, id, { ...args, text: 'changed' })).result.confirmed, false);
  assert.equal(sends(f).length, 2);
  // That ordinary call above deliberately stores its args; clear no data and check
  // transient persistence before it, not by erasing the fixture's audit trail.
});

test('transient send retains whitelist/permission and normal-action dedup guards', async t => {
  const f = await fixture(t, { config: { permission: 'full' } }); await f.online(); const id = await f.app.sessions.current();
  assert.equal((await call(f, id, { ...args, userId: '999999' })).result.status, 'blocked');
  assert.equal((await f.app.tools.call('qq_send_message', args, { id, permission: 'off', transientContext: true })).ok, false);
  const ordinary = { ...args, messageId: 'ordinary', text: 'public text' };
  assert.equal((await call(f, id, ordinary, false)).result.confirmed, true);
  assert.equal((await call(f, id, ordinary)).result.confirmed, false);
  assert.equal(sends(f).length, 1);
  await noPersistedBody(f);
});

for (const stop of [false, true]) test(`transient ${stop ? 'stop between segments' : 'cancel pending submission'} never replays on reload or host retry`, async t => {
  const f = await fixture(t, { config: { permission: 'full', requestTimeoutMs: 10000,
    segmentedReply: { ...segmentationDefaults, enabled: true, interval: '0.5,0.5' } } });
  await f.online(); const id = await f.app.sessions.current(), controller = new AbortController();
  if (!stop) f.setAction(r => r.action === 'send_private_msg');
  const pending = call(f, id, args, true, controller.signal);
  await until(() => sends(f).length === 1);
  if (stop) await f.app.runtime.action('qq', 'stop'); else controller.abort();
  await pending;
  await f.app.runtime.action('qq', stop ? 'start' : 'reload'); await f.online();
  const repeated = (await call(f, id)).result;
  assert.equal(repeated.confirmed, false); assert.equal(repeated.duplicate, true);
  assert.equal(repeated.delivery.outcome, stop ? 'partial' : 'unknown');
  assert.equal(repeated.delivery.sentParts, stop ? 1 : 0);
  const row = (await f.app.memory.readSession(id)).find((r: any) => r.type === 'channel_receipt' && r.direction === 'out');
  // Test harness only: obtain the registered public handle to exercise host retry.
  const registration = [...(f.app.channels as any).registrations.values()].find((r: any) => r.adapter.id === 'qq');
  const retried = await registration.handle.retry('direct:200002', row.external_message_id, { direction: 'out' });
  assert.notEqual(retried.status, 'sent');
  assert.equal(sends(f).length, 1, 'saved descriptor is never sent to QQ and remaining text is never reconstructed');
  await noPersistedBody(f);
  assert.equal(await f.app.runtime.services.get('witness')!.value.ping(), 'alive');
});
