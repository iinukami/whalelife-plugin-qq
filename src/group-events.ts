/*! Copyright (c) 2026 iinukami and contributors.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */
import { account, id, object, QQError } from './config.ts';
import { digest, faceText, segments } from './messages.ts';

export interface GroupEvent {
  kind: 'message' | 'poke';
  groupId: string; sender: string; messageId: string;
  groupName: string; nickname: string; card: string; text: string;
  atSelf: boolean; atAll: boolean; atUsers: string[];
}
export interface GroupInfo { groupId: string; name: string; memberCount: number }
export interface GroupMember { userId: string; name: string; nickname: string; card: string }

function accountOrEmpty(value: unknown) {
  try { return account(value); } catch { return ''; }
}

function nameOf(value: unknown) {
  return typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 128) : '';
}

const mediaLabels: Record<string, string> = {
  image: '[图片]', mface: '[表情包]', record: '[语音]', video: '[视频]', file: '[文件]',
  reply: '[引用消息]', json: '[分享卡片]', xml: '[分享卡片]', share: '[分享卡片]', forward: '[转发消息]',
};

function renderedMessage(raw: unknown) {
  const atUsers = new Set<string>();
  const parts = segments(raw).map(({ type, data }) => {
    if (type === 'text') return typeof data.text === 'string' ? data.text : '';
    if (type === 'at') {
      const target = data.qq === 'all' ? 'all' : accountOrEmpty(data.qq);
      if (!target) return '[提及]';
      atUsers.add(target);
      return target === 'all' ? '@全体成员' : '@' + target;
    }
    if (type === 'face') {
      const faceId = typeof data.id === 'number' || typeof data.id === 'string' ? String(data.id) : '';
      return faceText({ ...data, id: /^\d{1,8}$/.test(faceId) ? faceId : '' }) ?? '[QQ表情]';
    }
    return Object.hasOwn(mediaLabels, type) ? mediaLabels[type] : '[其他消息]';
  });
  return { text: parts.join('').slice(0, 16000), atUsers: [...atUsers] };
}

/** Only inspect contents after the current account and subscribed group match. */
export function normalizeGroupEvent(raw: Record<string, unknown>, accountId: string, allowed: (groupId: string) => boolean): GroupEvent | null {
  const message = raw.post_type === 'message' && raw.message_type === 'group';
  const poke = raw.post_type === 'notice' && raw.notice_type === 'notify' && raw.sub_type === 'poke';
  if (!message && !poke) return null;
  const groupId = accountOrEmpty(raw.group_id), sender = accountOrEmpty(raw.user_id);
  if (!accountId || accountOrEmpty(raw.self_id) !== accountId || !groupId || !sender || sender === accountId || !allowed(groupId)) return null;
  const profile = object(raw.sender);
  if (profile.user_id !== undefined && accountOrEmpty(profile.user_id) !== sender) return null;
  const common = { groupId, sender, groupName: nameOf(raw.group_name), nickname: nameOf(profile.nickname), card: nameOf(profile.card) };
  try {
    if (poke) {
      if (accountOrEmpty(raw.target_id) !== accountId) return null;
      // Some OneBot implementations supply only a second-granularity time. Repeated
      // notices in that second deliberately share a key rather than triggering twice.
      const sequence = raw.message_id === undefined ? '' : id(raw.message_id);
      const time = raw.time;
      const stable = sequence && sequence !== '0' ? sequence
        : typeof time === 'number' && Number.isSafeInteger(time) && time > 0 ? time : undefined;
      if (stable === undefined) return null;
      return { ...common, kind: 'poke', messageId: 'poke-' + digest([accountId, groupId, sender, stable]),
        text: '[戳了戳你]', atSelf: false, atAll: false, atUsers: [] };
    }
    const messageId = id(raw.message_id);
    if (messageId === '0') return null;
    const content = renderedMessage(raw.message ?? raw.raw_message);
    if (!content.text.trim()) return null;
    return { ...common, kind: 'message', messageId, ...content, atSelf: content.atUsers.includes(accountId), atAll: content.atUsers.includes('all') };
  } catch (error) {
    if (error instanceof QQError) return null;
    throw error;
  }
}

function groupInfo(raw: unknown): GroupInfo | undefined {
  const row = object(raw), groupId = accountOrEmpty(row.group_id);
  if (!groupId) return;
  return { groupId, name: nameOf(row.group_name),
    memberCount: typeof row.member_count === 'number' && Number.isSafeInteger(row.member_count) && row.member_count >= 0 ? row.member_count : 0 };
}

export function normalizeGroupList(raw: unknown): GroupInfo[] {
  if (!Array.isArray(raw)) throw new QQError('group_response', 'QQ 群列表格式无效。');
  return raw.map(groupInfo).filter((row): row is GroupInfo => row !== undefined);
}

export function normalizeGroupInfo(raw: unknown, expectedGroupId: string): GroupInfo {
  const info = groupInfo(raw);
  if (!info || info.groupId !== expectedGroupId) throw new QQError('group_response', 'QQ 返回的群资料与目标群不一致。');
  return info;
}

export function normalizeGroupMembers(raw: unknown, expectedGroupId: string): GroupMember[] {
  const groupId = account(expectedGroupId);
  if (!Array.isArray(raw)) throw new QQError('group_response', 'QQ 群成员列表格式无效。');
  const members: GroupMember[] = [];
  for (const value of raw) {
    const row = object(value), userId = accountOrEmpty(row.user_id);
    if (!userId || (row.group_id !== undefined && accountOrEmpty(row.group_id) !== groupId)) continue;
    const nickname = nameOf(row.nickname), card = nameOf(row.card);
    members.push({ userId, nickname, card, name: card || nickname || userId });
  }
  return members;
}
