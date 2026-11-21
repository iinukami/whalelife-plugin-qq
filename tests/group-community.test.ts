/*! Copyright (c) 2026 iinukami and contributors.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { fixture, until } from './fixture.ts';
import { temporaryDirectory } from './temporary-directory.ts';

const source = process.env.WHALELIFE_TEST_QQ_GROUP_PACKAGE;
const options = { skip: !source && 'set WHALELIFE_TEST_QQ_GROUP_PACKAGE to the extracted qq/group 0.6.6 release', timeout: 60000 };
const hashes = {
  'index.ts': 'ba9d827be88edaff1e298dac05274026bed4f74046925dd76b4c1118f01cc8f1',
  'plugin.yaml': '6ea6bf9e9770c131363cf4f9fe37a84af04ec6c46c4805d08e857bda23417f71',
};
const group = '310001', other = '310002', sender = '410001';
const groupMessage = (groupId: string, id: number, body: string, at = false) => ({
  message_type: 'group', sub_type: 'normal', group_id: Number(groupId), message_id: id, user_id: Number(sender),
  sender: { user_id: Number(sender), card: 'Member card', nickname: 'Member' },
  message: [...(at ? [{ type: 'at', data: { qq: '100001' } }] : []), { type: 'text', data: { text: body } }],
});

// Contract comparison only: keep the pinned community module intact, but simulate the
// author passing their existing rule list to registerGroupReceiver. Record which events
// actually crossed the QQ-to-consumer boundary, before the community's own filter.
const scopedEntry = `import { apply as community } from './community-original.ts';
export async function apply(ctx) {
  const parent = ctx.get('qq'), received = [];
  let config = await ctx.config.read();
  const service = Object.create(parent);
  Object.defineProperty(service, 'registerGroupReceiver', { value: (receive, options) =>
    parent.registerGroupReceiver(event => { received.push(event.messageId); return receive(event); },
      { ...options, allowsGroup: id => config.enabled === true && config.groups.some(rule => rule.groupId === id) }) });
  ctx.web.page('/plugins/qq/group/fixture-seen', (_req, res) => res.end(JSON.stringify(received)));
  await community({ ...ctx,
    get: (name, strict) => name === 'qq' ? service : ctx.get(name, strict),
    config: { read: (...args) => ctx.config.read(...args), save: async (name, value) => {
      await ctx.config.save(name, value);
      if (name === 'config.json') config = value;
    } }
  });
}`;

async function setup(t: TestContext, scoped: boolean) {
  const f = await fixture(t, { temporaryDirectory, includeQzone: false, config: { permission: 'full' },
    preparePlugin: async root => {
      const child = join(root, 'sub/group');
      await mkdir(child, { recursive: true });
      for (const [name, hash] of Object.entries(hashes)) {
        const bytes = await readFile(join(source!, name));
        assert.equal(createHash('sha256').update(bytes).digest('hex'), hash, name + ' must be the v0.6.6 release file');
        await writeFile(join(child, scoped && name === 'index.ts' ? 'community-original.ts' : name), bytes);
      }
      if (scoped) await writeFile(join(child, 'index.ts'), scopedEntry);
    } });
  await f.online();
  const child = f.app.runtime.records.get('qq/group');
  assert.equal(child?.status, 'active', child?.error);
  let sentId = 55001;
  f.setAction((req, socket) => {
    let data;
    switch (req.action) {
      case 'get_group_list':
        data = [group, other].map((id, i) => ({ group_id: Number(id), group_name: 'Room ' + i, member_count: 2 }));
        break;
      case 'get_group_member_list':
        data = [{ user_id: Number(sender), card: 'Member card', nickname: 'Member' }];
        break;
      case 'send_group_msg':
        data = { message_id: sentId++ };
        break;
      default:
        return false;
    }
    socket.send(JSON.stringify({ status: 'ok', retcode: 0, data, echo: req.echo }));
    return true;
  });
  const webId = await f.app.sessions.create('Synthetic private dialogue');
  assert.equal((await f.request('/api/session/current', { id: webId })).status, 200);
  const saveRules = async (groups: string[]) => {
    const path = '/plugins/qq/group/config';
    const old = await (await f.request(path)).json();
    const response = await f.request(path, { revision: old.revision, config: { ...old.config, enabled: true, personaId: 'a',
      permission: 'full', groups: groups.map(groupId => ({ groupId, mode: 'mention' })), followupSeconds: 0, replyOnKeyword: false } });
    assert.equal(response.status, 200, await response.text());
  };
  const privatePing = async (id: number) => {
    f.send({ message_id: id, message: [{ type: 'text', data: { text: 'PRIVATE_' + id } }] });
    await until(async () => (await f.status()).recent.some((n: any) => n.messageId === String(id) && n.status === 'sent'));
    assert.equal(await f.app.sessions.current(), webId);
  };
  const sends = () => f.calls.filter(c => c.action === 'send_group_msg');
  const childState = async () => (await f.request('/plugins/qq/group/status')).json();
  const groupCount = async () => (await childState()).groups.find((g: any) => g.groupId === group)?.messages;
  const say = async (args: Record<string, unknown>) => {
    const result = await f.app.tools.call('qq_group_say', { groupId: group, text: 'SYNTHETIC_TOOL_REPLY',
      actionId: 'group-acceptance', ...args }, { id: webId, personaId: 'a', permission: 'full' });
    assert.equal(result.ok, true, String(result.error));
    return result.result;
  };
  return { f, webId, privatePing, saveRules, sends, groupCount, say };
}

test('unmodified community 0.6.6 loads and lists groups; missing scope blocks group traffic without affecting private QQ', options, async t => {
  const { f, privatePing, saveRules, sends, groupCount, say } = await setup(t, false);
  const groups = await (await f.request('/plugins/qq/group/groups')).json();
  assert.ok(groups.groups.some((g: any) => g.groupId === group));
  await saveRules([group]);
  f.send(groupMessage(group, 701, 'LEGACY_INBOUND', true));
  await privatePing(801);
  assert.equal(await groupCount(), 0);
  assert.notEqual((await say({ replyTo: '701' })).status, 'sent');
  const membership = await (await f.request('/plugins/qq/group/members?groupId=' + group)).json();
  assert.equal(membership.members?.some((m: any) => m.userId === sender) ?? false, false);
  assert.equal(f.calls.filter(c => c.action === 'get_group_member_list').length, 0);
  assert.equal(sends().length, 0);
  assert.equal(f.generations.length, 1);
  await f.app.runtime.action('qq/group', 'stop');
  await privatePing(802);
  await f.app.runtime.action('qq/group', 'start');
  f.send(groupMessage(group, 702, 'LEGACY_AFTER_RESTART', true));
  await privatePing(803);
  assert.equal(await groupCount(), 0);
  assert.equal(sends().length, 0);
  assert.equal(f.calls.filter(c => c.action === 'send_private_msg').length, 3);
});

test('0.6.6 scope adapter comparison routes only authorized groups, replies with a quote and keeps private history independent', options, async t => {
  const { f, webId, privatePing, saveRules, sends, say } = await setup(t, true);
  const seen = async (): Promise<string[]> => (await f.request('/plugins/qq/group/fixture-seen')).json();
  f.send(groupMessage(group, 710, 'EMPTY_SCOPE', true));
  await privatePing(810);
  assert.deepEqual(await seen(), []);
  await saveRules([group]);
  f.send(groupMessage(other, 711, 'OUTSIDE_RULE', true));
  f.send(groupMessage(group, 712, 'PASSIVE_GROUP'));
  f.send(groupMessage(group, 713, 'GROUP_QUESTION', true));
  await privatePing(811);
  await until(() => sends().length >= 1);
  await until(async () => (await seen()).includes('713'));
  assert.deepEqual(await seen(), ['712', '713']);
  assert.equal(sends().length, 1);
  assert.equal(String(sends()[0].params.group_id), group);
  const quote = sends()[0].params.message.find((s: any) => s.type === 'reply');
  assert.equal(String(quote?.data.id), '713');
  const membership = await (await f.request('/plugins/qq/group/members?groupId=' + group)).json();
  assert.equal(membership.members.find((m: any) => m.userId === sender)?.card, 'Member card');
  const cached = await f.app.tools.call('qq_group_read', { groupId: group }, { id: webId, permission: 'full' });
  assert.equal(cached.result.status, 'ready');
  assert.ok(cached.result.messages.some((m: any) => m.messageId === '712' && m.text.includes('PASSIVE_GROUP')));
  const pm = JSON.stringify(await f.app.memory.readSession(webId));
  assert.ok(pm.includes('PRIVATE_811') && !pm.includes('GROUP_QUESTION') && !pm.includes('PASSIVE_GROUP'));
  const ids = Object.keys(await f.app.memory.listSessionMeta()).filter(id => id !== webId);
  const containing = await Promise.all(ids.map(async id => JSON.stringify(await f.app.memory.readSession(id))));
  assert.equal(containing.filter(s => s.includes('GROUP_QUESTION') && !s.includes('PRIVATE_811')).length, 1);
  assert.equal(containing.some(s => s.includes('PASSIVE_GROUP') || s.includes('OUTSIDE_RULE')), false);
  const explicit = await say({ atUserIds: [sender], replyTo: '713' });
  assert.equal(explicit.status, 'sent', explicit.error);
  assert.equal(explicit.confirmed, true);
  const explicitMessage = sends().at(-1)!.params.message;
  assert.equal(String(explicitMessage.find((s: any) => s.type === 'at')?.data.qq), sender);
  assert.equal(String(explicitMessage.find((s: any) => s.type === 'reply')?.data.id), '713');
  await saveRules([other]);
  f.send(groupMessage(group, 714, 'REVOKED_SCOPE', true));
  f.send(groupMessage(other, 715, 'NEW_SCOPE', true));
  await until(() => sends().length >= 3);
  assert.deepEqual(await seen(), ['712', '713', '715']);
  assert.equal(String(sends()[2].params.group_id), other);
  await f.app.runtime.action('qq/group', 'stop');
  f.send(groupMessage(other, 716, 'STOPPED_CHILD', true));
  await privatePing(812);
  assert.equal(sends().length, 3);
  await f.app.runtime.action('qq/group', 'start');
  f.send(groupMessage(other, 717, 'RESTARTED_CHILD', true));
  await until(() => sends().length >= 4);
  assert.deepEqual(await seen(), ['717']);

  // Two silent PCM samples and a single red PNG pixel, both generated for this test.
  const wav = 'UklGRigAAABXQVZFZm10IBAAAAABAAEAgD4AAAB9AAACABAAZGF0YQQAAAAAAAAA';
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADElEQVQImWP4z8AAAAMBAQCc479ZAAAAAElFTkSuQmCC';
  const qq = f.app.runtime.services.get('qq')!.value;
  const media = [
    { parts: [{ type: 'voice', mime: 'audio/wav', base64: wav }],
      expected: [{ type: 'record', data: { file: 'base64://' + wav } }] },
    { parts: [{ type: 'text', text: 'CAPTION' }, { type: 'image', mime: 'image/png', base64: png }],
      expected: [{ type: 'text', data: { text: 'CAPTION' } }, { type: 'image', data: { file: 'base64://' + png, sub_type: 0 } }] },
  ];
  for (const { parts, expected } of media) {
    const before = sends().length;
    const receipt = await qq.sendGroupMedia({ groupId: other, parts });
    assert.equal(receipt.status, 'sent', receipt.error);
    assert.equal(receipt.confirmed, true);
    assert.equal(receipt.messageId, String(55001 + before));
    assert.equal(sends().length, before + 1);
    assert.equal(String(sends()[before].params.group_id), other);
    assert.deepEqual(sends()[before].params.message, expected);
  }
  await saveRules([]);
  const beforeRevoked = sends().length;
  for (const { parts } of media) {
    const receipt = await qq.sendGroupMedia({ groupId: other, parts });
    assert.equal(receipt.status, 'not_submitted');
    assert.equal(receipt.confirmed, false);
  }
  assert.equal(sends().length, beforeRevoked);
});
