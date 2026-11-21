/*! Copyright (c) 2026 iinukami and contributors.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeGroupEvent, normalizeGroupInfo, normalizeGroupList, normalizeGroupMembers } from '../src/group-events.ts';

const self = '100001', group = '200001', otherGroup = '200002';
const raw = {
  post_type: 'message', message_type: 'group', message_id: -101, group_id: Number(group),
  self_id: Number(self), user_id: 300001, sender: { user_id: 300001, card: '群名片', nickname: '昵称' },
  group_name: '测试群', message: '你好',
};
const read = (value: Record<string, unknown>) => normalizeGroupEvent(value, self, id => id === group);

test('group message scopes identity before reading contents, preserving signed and large string IDs', () => {
  assert.deepEqual(read(raw), { kind: 'message', groupId: group, sender: '300001', messageId: '-101',
    groupName: '测试群', nickname: '昵称', card: '群名片', text: '你好', atSelf: false, atAll: false, atUsers: [] });
  assert.equal(read({ ...raw, message_id: '99999999999999999999' })?.messageId, '99999999999999999999');
  for (const fields of [{ group_id: otherGroup }, { self_id: '999999' }, { user_id: self },
    { message_type: 'private' }, { post_type: 'message_sent' }, { message_id: 0 },
    { sender: { user_id: '888888' } }, { message_id: Number.MAX_SAFE_INTEGER + 1 }]) {
    assert.equal(read({ ...raw, ...fields }), null);
  }
  const forbidden = { ...raw, group_id: otherGroup, get message() { throw Error('unauthorized content inspected'); } };
  assert.equal(read(forbidden), null);
  assert.equal(read({ ...raw, message: Array.from({ length: 129 }, () => ({ type: 'text', data: { text: 'a' } })) }), null);
});

test('mentions come from actual OneBot segments, including CQ strings but excluding user-escaped text', () => {
  const event = read({ ...raw, message: '[CQ:at,qq=100001][CQ:at,qq=all][CQ:at,qq=100001]好' });
  assert.deepEqual(event?.atUsers, [self, 'all']);
  assert.equal(event?.atSelf, true); assert.equal(event?.atAll, true);
  for (const message of ['&#91;CQ:at,qq=100001&#93;', [{ type: 'text', data: { text: '[CQ:at,qq=100001] @全体成员' } }]]) {
    assert.deepEqual(read({ ...raw, message })?.atUsers, []);
  }
  const allOnly = read({ ...raw, message: [{ type: 'at', data: { qq: 'all' } }] });
  assert.equal(allOnly?.atSelf, false); assert.equal(allOnly?.atAll, true);
});

test('group media and references are bounded text; private download fields never reach the receiver', () => {
  const marker = 'SYNTHETIC_UNDELIVERED_ATTACHMENT';
  const message = ['image', 'record', 'video', 'mface', 'reply', 'json', 'face', 'unknown'].map(type => ({
    type, data: { url: marker, file: marker, id: '14', data: marker },
  }));
  const result = read({ ...raw, message });
  assert.equal(result?.text, '[图片][语音][视频][表情包][引用消息][分享卡片][QQ表情：微笑][其他消息]');
  assert.equal(JSON.stringify(result).includes(marker), false);
  assert.equal(read({ ...raw, message: 'x'.repeat(20000) })?.text.length, 16000);
  assert.equal(read({ ...raw, message: [{ type: 'face', data: { id: '__proto__' } }] })?.text, '[QQ表情]');
});

test('only group pokes addressed to the logged in account have stable, non-quotable event IDs', () => {
  const poke = { post_type: 'notice', notice_type: 'notify', sub_type: 'poke', group_id: group,
    self_id: self, user_id: 300001, target_id: self, time: 1800000000 };
  const first = read(poke);
  assert.equal(first?.kind, 'poke'); assert.match(first!.messageId, /^poke-[a-f0-9]{64}$/);
  assert.equal(first?.messageId, read(poke)?.messageId);
  assert.notEqual(first?.messageId, read({ ...poke, time: poke.time + 1 })?.messageId);
  assert.equal(read({ ...poke, target_id: 300002 }), null);
  assert.equal(read({ ...poke, group_id: otherGroup }), null);
  assert.equal(read({ ...poke, user_id: self }), null);
  assert.equal(read({ ...poke, time: undefined }), null);
  assert.equal(read({ ...poke, notice_type: 'group_increase' }), null);
});

test('public group queries expose only named fields and reject cross-group results', () => {
  const meta = { group_id: Number(group), group_name: '群', member_count: 2, internal: 'SYNTHETIC_HIDDEN' };
  const info = { groupId: group, name: '群', memberCount: 2 };
  assert.deepEqual(normalizeGroupList([meta, { group_id: 'invalid' }]), [info]);
  assert.deepEqual(normalizeGroupInfo(meta, group), info);
  assert.throws(() => normalizeGroupInfo(meta, otherGroup));
  assert.throws(() => normalizeGroupList({ list: [meta] }));
  assert.deepEqual(normalizeGroupMembers([
    { group_id: Number(group), user_id: 300001, nickname: '昵称', card: '名片', hidden: 'SYNTHETIC_HIDDEN' },
    { user_id: '300002', nickname: '昵称二' },
    { group_id: Number(otherGroup), user_id: 300003 },
    { group_id: group, user_id: false },
  ], group), [
    { userId: '300001', name: '名片', card: '名片', nickname: '昵称' },
    { userId: '300002', name: '昵称二', card: '', nickname: '昵称二' },
  ]);
  assert.throws(() => normalizeGroupMembers({ data: [] }, group));
});
