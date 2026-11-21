/*! Copyright (c) 2026 iinukami and contributors.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */
import type { Context } from 'whalelife';
import { account, QQError, safeError, type Config } from './config.ts';
import { normalizeGroupInfo, normalizeGroupList, normalizeGroupMembers } from './group-events.ts';
import { GroupOutbound, type GroupMediaInput, type GroupTextInput } from './group-outbound.ts';
import type { GroupSubscription } from './group-subscription.ts';
import type { OneBot } from './onebot.ts';

export type GroupOptions = { signal?: AbortSignal };
type Submit = ConstructorParameters<typeof GroupOutbound>[2]['submit'];

/** One verified OneBot account. Whitelists and chat policy belong to the subscribing plugin. */
export class GroupConnection {
  private outbound: GroupOutbound;
  private accountId: string;
  private bot: OneBot;
  private subscription: GroupSubscription;
  private lifetime: AbortSignal;
  private activeSends = 0;

  constructor(ctx: Context, config: Config, bot: OneBot, subscription: GroupSubscription, lifetime: AbortSignal, submit: Submit) {
    this.accountId = config.accountId;
    this.bot = bot;
    this.subscription = subscription;
    this.lifetime = lifetime;
    this.outbound = new GroupOutbound(ctx, config, {
      authorize: groupId => subscription.authorize(config.accountId, groupId),
      canQuote: (groupId, messageId) => subscription.known(config.accountId, groupId, messageId),
      submit,
    });
  }
  private signal(options?: GroupOptions) {
    const signals = [this.lifetime, this.subscription.signal(this.accountId)];
    if (options?.signal) signals.push(options.signal);
    const signal = AbortSignal.any(signals);
    signal.throwIfAborted();
    return signal;
  }
  async listGroups(options?: GroupOptions) {
    const signal = this.signal(options);
    const rows = await this.bot.request('get_group_list', {}, signal);
    signal.throwIfAborted();
    return normalizeGroupList(rows);
  }
  async groupInfo(groupId: string, options?: GroupOptions) {
    groupId = account(groupId);
    const signal = this.signal(options);
    await this.subscription.authorize(this.accountId, groupId);
    const row = await this.bot.request('get_group_info', { group_id: groupId }, signal);
    await this.subscription.authorize(this.accountId, groupId);
    signal.throwIfAborted();
    return normalizeGroupInfo(row, groupId);
  }
  async listGroupMembers(groupId: string, options?: GroupOptions) {
    groupId = account(groupId);
    const signal = this.signal(options);
    await this.subscription.authorize(this.accountId, groupId);
    const rows = await this.bot.request('get_group_member_list', { group_id: groupId }, signal);
    await this.subscription.authorize(this.accountId, groupId);
    signal.throwIfAborted();
    return normalizeGroupMembers(rows, groupId);
  }
  async sendText(input: GroupTextInput, options?: GroupOptions) {
    const signal = this.signal(options);
    if (this.activeSends >= 8) throw new QQError('busy', '群发送队列已满，未提交。', true);
    // A poke can trigger a channel reply but has no platform message to quote.
    if (typeof input?.replyTo === 'string' && input.replyTo.startsWith('poke-') &&
      this.subscription.known(this.accountId, input.groupId, input.replyTo)) input = { ...input, replyTo: undefined };
    this.activeSends++;
    try { return await this.outbound.sendText(input, signal); }
    finally { this.activeSends--; }
  }
  async sendMedia(input: GroupMediaInput, options?: GroupOptions) {
    try {
      const signal = this.signal(options);
      if (this.activeSends >= 8) throw new QQError('busy', '群发送队列已满，未提交。', true);
      this.activeSends++;
      try { return await this.outbound.sendMedia(input, signal); }
      finally { this.activeSends--; }
    } catch (error) { return { status: 'not_submitted', confirmed: false, retryAutomatically: false, error: safeError(error) }; }
  }
}
