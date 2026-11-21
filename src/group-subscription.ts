/*! Copyright (c) 2026 iinukami and contributors.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */
import { account, QQError } from './config.ts';
import { normalizeGroupEvent, type GroupEvent } from './group-events.ts';

export type GroupReceiver = (event: GroupEvent) => void | Promise<void>;
export interface GroupSubscriptionOptions {
  signal: AbortSignal;
  allowsGroup?: (groupId: string) => boolean | Promise<boolean>;
}

interface Registration {
  accountId: string;
  receive: GroupReceiver;
  allowsGroup?: GroupSubscriptionOptions['allowsGroup'];
  signal: AbortSignal;
  dispose: () => void;
  seen: Set<string>;
  pending: number;
  tail: Promise<void>;
}

const denied = () => new QQError('group_scope', '此群未获得当前群聊插件的授权。', true);
async function bounded<T>(signal: AbortSignal, run: () => T | Promise<T>): Promise<T> {
  signal.throwIfAborted();
  let stop!: () => void;
  const cancel = new Promise<never>((_, reject) => { stop = () => reject(denied()); });
  const timer = setTimeout(stop, 3000);
  signal.addEventListener('abort', stop, { once: true });
  try { return await Promise.race([run(), cancel]); }
  finally { clearTimeout(timer); signal.removeEventListener('abort', stop); }
}
export class GroupSubscription {
  private entry?: Registration;

  register(accountId: string, receive: GroupReceiver, options: GroupSubscriptionOptions) {
    accountId = account(accountId);
    if (typeof receive !== 'function' || !options?.signal || typeof options.signal.addEventListener !== 'function' ||
      (options.allowsGroup !== undefined && typeof options.allowsGroup !== 'function'))
      throw new QQError('group_receiver', '群接收需要有效的回调与生命周期信号。', true);
    options.signal.throwIfAborted();
    if (this.entry) throw new QQError('group_receiver', '已有群接收器，请先注销。', true);
    const lifetime = new AbortController();
    const dispose = () => {
      if (this.entry !== entry) return;
      this.entry = undefined;
      lifetime.abort();
      entry.seen.clear();
      options.signal.removeEventListener('abort', dispose);
    };
    const entry: Registration = { accountId, receive, allowsGroup: options.allowsGroup, signal: lifetime.signal,
      dispose, seen: new Set(), pending: 0, tail: Promise.resolve() };
    this.entry = entry;
    options.signal.addEventListener('abort', dispose, { once: true });
    return dispose;
  }

  dispose() { this.entry?.dispose(); }
  scope(accountId: string) {
    if (!this.entry || this.entry.accountId !== accountId) return 'inactive';
    return this.entry.allowsGroup ? 'scoped' : 'missing';
  }
  signal(accountId: string) {
    if (!this.entry || this.entry.accountId !== accountId) throw denied();
    return this.entry.signal;
  }
  async authorize(accountId: string, groupId: string) {
    const entry = this.entry;
    if (!entry || entry.accountId !== accountId || !entry.allowsGroup) throw denied();
    let allowed = false;
    try { allowed = await bounded(entry.signal, () => entry.allowsGroup!(account(groupId))) === true; } catch { /* A failed scope lookup grants nothing. */ }
    if (!allowed || this.entry !== entry || entry.signal.aborted) throw denied();
  }
  known(accountId: string, groupId: string, messageId: string) {
    return this.entry?.accountId === accountId && this.entry.seen.has(groupId + '/' + messageId);
  }
  offer(raw: Record<string, unknown>, accountId: string, runtimeSignal: AbortSignal) {
    const entry = this.entry;
    if (!entry?.allowsGroup || entry.accountId !== accountId || runtimeSignal.aborted || entry.pending >= 64) return;
    let groupId: string;
    try {
      if (account(raw.self_id) !== accountId || account(raw.user_id) === accountId) return;
      groupId = account(raw.group_id);
    } catch { return; }
    entry.pending++;
    entry.tail = entry.tail.then(async () => {
      if (runtimeSignal.aborted || entry.signal.aborted) return;
      await this.authorize(accountId, groupId);
      if (runtimeSignal.aborted || this.entry !== entry) return;
      const event = normalizeGroupEvent(raw, accountId, id => id === groupId);
      if (!event) return;
      const key = groupId + '/' + event.messageId;
      if (entry.seen.has(key)) return;
      if (entry.seen.size >= 2048) entry.seen.delete(entry.seen.values().next().value!);
      entry.seen.add(key);
      await bounded(entry.signal, () => entry.receive(event));
    }).catch(() => { /* Revocation or a failing group consumer cannot interrupt private chat. */ }).finally(() => { entry.pending--; });
  }
}
