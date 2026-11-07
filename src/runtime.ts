/*! Copyright (c) 2026 iinukami and contributors.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */
import { setTimeout as delay } from 'node:timers/promises';
import type { Context, ChannelHandle, OutgoingMessage } from 'whalelife';
import { object, account, id, safeError, QQError, type Config } from './config.ts';
import { OneBot, type LinkState } from './onebot.ts';
import { MediaReader } from './media.ts';
import { privateEvent, digest, splitText, type PrivateEvent } from './messages.ts';
import { replyPlan } from './segmentation.ts';
import { InboundMedia } from './inbound-media.ts';
import { OutboundMedia, type MediaAction, type MediaKey, type MediaSendOptions } from './outbound-media.ts';
import { SpaceTransport } from './space/transport.ts';
import { SpaceWebTransport } from './space/web-transport.ts';
import type { PublishPayload } from './space/types.ts';
import { textDeliveryReceipt, unknownDelivery, type Delivery, type TextDeliveryReceipt } from './text-delivery.ts';

interface Inbox { version: 1; fingerprint: string; state: 'preparing' | 'ready' | 'failed'; text?: string; sessionId?: string; }
export interface Notice { at: string; messageId?: string; status: string; detail?: string; }
export class QQRuntime {
  private ctx: Context;
  readonly config: Config;
  private controller = new AbortController();
  readonly signal: AbortSignal;
  private bot: OneBot;
  private space: SpaceTransport;
  readonly spaceWeb: SpaceWebTransport;
  private media: MediaReader;
  private channel: ChannelHandle;
  private tail: Promise<void> = Promise.resolve();
  private sending: Promise<void> = Promise.resolve();
  private directSending: Promise<unknown> = Promise.resolve();
  private bindingSync?: Promise<void>;
  private inboundMedia: InboundMedia;
  private outboundMedia: OutboundMedia;
  private mediaActions = 0;
  private incomingBinding?: { peer: string; sessionId: string };
  private blockedModelBindings = new Map<string, QQError>();
  private bindingState: { state: 'waiting' | 'ready'; sessionId?: string; error?: string } = { state: 'waiting' };
  private modelSend?: { sessionId: string; peer: string; text: string };
  // Only the redacted descriptor enters the public channel's durable dedup index.
  // The original exists solely during this call; a host retry cannot replay it.
  private transientSend?: { sessionId: string; peer: string; descriptor: string; text: string };
  private inflight = new Set<string>();
  private lastSent = 0;
  private deliveryResults = new Map<string, TextDeliveryReceipt>();
  private stopped = false;
  private stopPromise?: Promise<void>;
  state: LinkState = { state: 'disconnected' };
  recent: Notice[] = [];
  constructor(ctx: Context, config: Config, inboundMedia = new InboundMedia()) {
    this.ctx = ctx; this.config = config;
    this.inboundMedia = inboundMedia;
    this.signal = AbortSignal.any([ctx.signal, this.controller.signal]);
    this.bot = new OneBot(config, this.signal, event => this.accept(event), state => { this.state = state; });
    this.space = new SpaceTransport(this.bot, this.signal, () => ({ accountId: this.config.accountId, online: this.state.state === 'online' }));
    this.spaceWeb = new SpaceWebTransport(this.bot, this.signal, () => ({ accountId: this.config.accountId, online: this.state.state === 'online' }));
    this.outboundMedia = new OutboundMedia(ctx, config, async (userId, message, interval, signal, markPending) => {
      await delay(Math.max(interval, this.config.minReplyIntervalMs - (Date.now() - this.lastSent)), undefined, { signal });
      signal.throwIfAborted();
      if (this.state.state !== 'online') throw new QQError('offline', 'QQ 尚未在线，未发送。');
      await markPending(); signal.throwIfAborted();
      const result = await this.bot.request('send_private_msg', {
        user_id: Number.isSafeInteger(Number(userId)) ? Number(userId) : userId, message, auto_escape: true,
      }, signal);
      const messageId = id(result.message_id);
      if (messageId === '0') throw new QQError('uncertain', '协议端未提供有效消息 ID，结果不确定。');
      this.lastSent = Date.now(); return messageId;
    });
    this.media = new MediaReader(ctx, config, this.bot, this.signal);
    this.channel = ctx.channels.register({ id: 'qq', name: 'QQ 私聊', account: config.accountId, persona: config.personaId,
      permission: config.permission, send: (message, { signal }) => {
        const task = this.sending.then(() => {
          if (message.replyTo === undefined && message.text.startsWith('[QQ 临时私聊；正文不留存；')) {
            const pending = this.transientSend;
            if (!pending || pending.sessionId !== message.sessionId || pending.peer !== message.peer || pending.descriptor !== message.text)
              throw new QQError('transient', '临时私聊正文未保留，不能重试原文；请核对已有投递回执。');
            message = { ...message, text: pending.text, transient: true };
          }
          return this.deliver(message, AbortSignal.any([signal, this.signal]));
        });
        this.sending = task.catch(() => {}); return task;
      } });
  }
  start() {
    this.bot.start();
    if (typeof this.ctx.sessions.current === 'function' && !this.bindingSync)
      this.bindingSync = this.syncBindings();
  }
  private bindingKey(peer: string, sessionId: string) { return digest([peer, sessionId]); }
  private async syncBindings() {
    while (!this.signal.aborted) {
      try {
        if (this.state.state === 'online') {
          // Login must not create a conversation. Only synchronize an existing selection.
          const sessions = await this.ctx.sessions.list();
          if (sessions.length) {
            const sessionId = await this.ctx.sessions.current();
            const task = this.directSending.then(async () => {
              this.signal.throwIfAborted();
              if (await this.ctx.sessions.current() !== sessionId) return;
              if (this.incomingBinding) {
                this.bindingState = { state: 'waiting', sessionId, error: '正在处理已固定会话的入站消息，完成后同步。' };
                return;
              }
              this.bindingState = { state: 'waiting', sessionId };
              for (const userId of this.config.allowedUsers.filter(id => id !== this.config.accountId)) {
                await this.followCurrentSession(`direct:${userId}`, this.signal, sessionId);
              }
              this.bindingState = { state: 'ready', sessionId };
            });
            this.directSending = task.catch(() => {});
            await task;
          } else this.bindingState = { state: 'waiting' };
        }
      } catch (error) {
        // Busy routes are expected. This loop only prepares bindings, never replays a send.
        this.bindingState = { ...this.bindingState, state: 'waiting', error: safeError(error) };
      }
      try { await delay(1000, undefined, { signal: this.signal }); }
      catch { break; }
    }
  }
  private async followCurrentSession(peer: string, signal = this.signal, targetSession?: string) {
    signal.throwIfAborted();
    if (!targetSession && typeof this.ctx.sessions.current !== 'function') return;
    const sessionId = targetSession ?? await this.ctx.sessions.current();
    if (this.incomingBinding?.peer === peer && this.incomingBinding.sessionId !== sessionId)
      throw new QQError('binding', '该私聊正在处理当前消息，暂不能切换它的会话；本次未发送。');
    const file = `session-binding-${digest([this.config.accountId, peer])}.json`;
    const saved = await this.ctx.config.read<{ version?: number; sessionId?: string }>(file);
    if (saved.version !== undefined && (saved.version !== 1 || typeof saved.sessionId !== 'string'))
      throw new QQError('session', 'QQ 会话绑定记录版本或格式无效，原记录已保留。');
    signal.throwIfAborted();
    try {
      await this.channel.bind(peer, sessionId);
    } catch (error) {
      signal.throwIfAborted();
      // context can create a route. Use it only for the host's explicit existing-
      // binding conflict, never for a missing target, storage failure or cancellation.
      let previous = saved.sessionId;
      if (error instanceof Error && error.message === 'bind 不支持迁移已绑定路由，请显式 rebind') {
        try { previous = (await this.channel.context(peer)).id; }
        catch { /* A deleted target needs our last successful binding. */ }
      }
      signal.throwIfAborted();
      if (!previous) throw new QQError('session', '无法确认 QQ 原会话，请检查会话是否已删除；本条未生成或发送回复。');
      try { await this.channel.rebind(peer, { expectedSessionId: previous, sessionId }); }
      catch { throw new QQError('binding', 'QQ 会话切换未完成，请等待正在进行的回复结束并检查会话状态；本条未生成或发送回复。'); }
    }
    signal.throwIfAborted();
    if (saved.sessionId !== sessionId) await this.ctx.config.save(file, { version: 1, sessionId });
    // A real successful bind/rebind is the only recovery boundary. A timer or a new
    // action ID cannot unlock a failed model attempt while its session is still busy.
    this.blockedModelBindings.delete(this.bindingKey(peer, sessionId));
  }
  private notice(status: string, messageId?: string, detail?: string) {
    this.recent.unshift({ at: new Date().toISOString(), messageId, status, detail });
    this.recent = this.recent.slice(0, 30);
    if (detail && !this.ctx.signal.aborted) {
      try { this.ctx.logger.warn('QQ 私聊处理提示', { status, detail }); } catch { /* old context */ }
    }
  }
  private accept(raw: Record<string, unknown>) {
    if (this.signal.aborted || this.stopped) return;
    let event: PrivateEvent | null;
    try { event = privateEvent(raw, this.config); }
    catch (error) { this.notice('invalid_event', undefined, safeError(error)); return; }
    if (!event) return;
    const key = `${event.peer}/${event.messageId}`;
    if (this.inflight.has(key)) return;
    if (this.inflight.size >= 64) { this.notice('busy', event.messageId, '待处理私聊过多，本条未接收。'); return; }
    this.inflight.add(key);
    this.tail = this.tail.then(async () => {
      this.signal.throwIfAborted();
      await this.receive(event!);
    }).catch(error => {
      if (!this.signal.aborted) this.notice('failed', event!.messageId, safeError(error));
    }).finally(() => { this.inflight.delete(key); });
  }
  private async receive(event: PrivateEvent) {
    const file = `inbox-${digest([this.config.accountId, event.peer, event.messageId])}.json`;
    let saved = await this.ctx.config.read<Partial<Inbox>>(file);
    this.signal.throwIfAborted();
    if (saved.version !== undefined && saved.version !== 1) throw new QQError('state_version', '收件状态版本不受支持，原数据已保留。');
    if (saved.sessionId !== undefined && (typeof saved.sessionId !== 'string' || !saved.sessionId || saved.sessionId.length > 200))
      throw new QQError('state', '收件会话记录无效，原数据已保留。');
    if (saved.fingerprint && saved.fingerprint !== event.fingerprint) throw new QQError('duplicate_conflict', '同一消息 ID 的内容发生变化，已拒绝处理。');
    if (saved.state === 'preparing' || saved.state === 'failed') {
      this.notice('uncertain', event.messageId, '这条消息的识别曾中断或失败，未自动重做。请修正配置后以新消息重发。'); return;
    }
    const normalize = async (sessionId?: string) => {
      saved = { version: 1, fingerprint: event.fingerprint, state: 'preparing', ...(sessionId ? { sessionId } : {}) };
      await this.ctx.config.save(file, saved);
      try {
        const text = await this.media.normalize(event, sessionId ? (bytes, mime, imageIndex) => this.inboundMedia.offer({
          sessionId, messageId: event.messageId, imageIndex, mime, base64: bytes.toString('base64'),
        }, this.signal) : undefined);
        this.signal.throwIfAborted();
        saved = { ...saved, state: 'ready', text };
        await this.ctx.config.save(file, saved);
      } catch (error) {
        if (!this.signal.aborted) await this.ctx.config.save(file, { ...saved, state: 'failed' });
        throw error;
      }
    };
    // Preserve the old selection timing when the optional media receiver is absent.
    if (saved.state !== 'ready' && !this.inboundMedia.active()) await normalize();
    // Serialize only route preparation, never the model round: a tool in this round
    // may call sendText and must not wait behind the round that is calling it.
    const prepare = this.directSending.then(async () => {
      await this.followCurrentSession(event.peer, this.signal, saved.sessionId);
      const sessionId = (await this.channel.context(event.peer)).id;
      this.signal.throwIfAborted();
      this.incomingBinding = { peer: event.peer, sessionId };
      return sessionId;
    });
    this.directSending = prepare.catch(() => {});
    const sessionId = await prepare;
    try {
      if (saved.state !== 'ready') await normalize(sessionId);
      if (typeof saved.text !== 'string') throw new QQError('state', '收件记录不完整，已停止处理。');
      this.signal.throwIfAborted();
      const result = await this.describeDelivery(await this.channel.receive({ peer: event.peer, sender: event.sender, messageId: event.messageId, text: saved.text }, { signal: this.signal }));
      this.notice(result.status, event.messageId, result.delivery.summary);
    } finally { this.incomingBinding = undefined; }
  }
  private async deliver(message: OutgoingMessage, signal: AbortSignal) {
    let ledger: Delivery | undefined, failure: unknown, failed = false;
    try { await this.deliverParts(message, signal, value => { ledger = value; }); }
    catch (error) { failed = true; failure = error; }
    const receipt = ledger ? textDeliveryReceipt(ledger) : unknownDelivery();
    this.deliveryResults.set(message.deliveryId, receipt);
    if (this.deliveryResults.size > 128) this.deliveryResults.delete(this.deliveryResults.keys().next().value!);
    // Auto-reply failures happen after the model's final text. Record facts through
    // the public memory API so its next turn can distinguish writing from sending.
    if (message.replyTo !== undefined && (receipt.outcome !== 'sent' || ledger?.reportFailure)) {
      try {
        if (ledger && receipt.totalParts !== 0 && receipt.outcome !== 'sent' && !ledger.reportFailure) {
          ledger.reportFailure = true;
          await this.ctx.config.save(`delivery-${digest(message.deliveryId)}.json`, ledger).catch(() => {});
        }
        await this.ctx.memory.recordExperience(message.sessionId, {
          event_id: `qq-text:${digest(message.deliveryId)}:${receipt.outcome}:${receipt.sentParts}:${receipt.unknownParts}`,
          outcome: receipt.outcome === 'sent' ? 'succeeded' : receipt.unknownParts !== 0 ? 'pending' : 'failed',
          text: `QQ 自动回复投递结果（入站消息 ${message.replyTo}）：${receipt.summary}`,
          origin: { platform: 'QQ 私聊', action: '自动回复投递结果' }, occurred_at: new Date().toISOString(),
        });
      } catch { this.notice('delivery_memory_unavailable', message.replyTo, '投递事实未能写入会话；不会因此重发。'); }
    }
    if (failed) throw new QQError(failure instanceof QQError ? failure.code : 'delivery', receipt.summary + ' ' + safeError(failure));
  }
  private async describeDelivery(result: Awaited<ReturnType<ChannelHandle['send']>>) {
    let delivery = result.deliveryId ? this.deliveryResults.get(result.deliveryId) : undefined;
    if (result.deliveryId) this.deliveryResults.delete(result.deliveryId);
    if (!delivery && result.deliveryId) {
      try {
        const ledger = await this.ctx.config.read<Delivery>(`delivery-${digest(result.deliveryId)}.json`);
        if (ledger.version === 1) delivery = textDeliveryReceipt(ledger);
      } catch { /* Missing/corrupt storage cannot prove that a send did not happen. */ }
    }
    delivery ??= unknownDelivery();
    // The host only records sent after the adapter confirms completion. A failed
    // private receipt write must not turn that durable confirmation into unknown.
    if (result.status === 'sent' && delivery.outcome !== 'sent') {
      const total = delivery.totalParts || null;
      delivery = { ...delivery, outcome: 'sent', totalParts: total, sentParts: total,
        notSentParts: 0, unknownParts: 0, unattemptedParts: 0,
        summary: '渠道已记录平台确认全部发送；逐段消息 ID 可能未保存。发送确认不代表对方已读。' };
    }
    return { ...result, delivery, ...(result.status !== 'sent' && result.status !== 'generation_failed' ? { error: delivery.summary } : {}) };
  }
  private async deliverParts(message: OutgoingMessage, signal: AbortSignal, observe: (ledger: Delivery) => void) {
    signal.throwIfAborted();
    if (!message.peer.startsWith('direct:')) throw new QQError('peer', '首版只支持好友私聊。');
    const target = account(message.peer.slice(7));
    if (!this.config.allowedUsers.includes(target) || target === this.config.accountId) throw new QQError('peer', '发送对象不在私聊白名单内。');
    const file = `delivery-${digest(message.deliveryId)}.json`;
    let saved = await this.ctx.config.read<Partial<Delivery>>(file);
    const fingerprint = digest([message.peer, message.text]);
    if (saved.version !== undefined && saved.version !== 1) throw new QQError('state_version', '发送状态版本不受支持。');
    if (saved.fingerprint && saved.fingerprint !== fingerprint) throw new QQError('delivery_conflict', '投递标识与内容不匹配。');
    if (!Object.keys(saved).length) observe({ version: 1, fingerprint, partCount: 0, parts: [] });
    // A transient reply is sent once live. Its text/plan must never enter private storage,
    // and an existing transient receipt is never permission to reconstruct or replay it.
    if (saved.transient) {
      observe(saved as Delivery);
      if (saved.parts?.length && saved.parts.length === saved.partCount && saved.parts.every(p => p.state === 'sent')) return;
      throw new QQError('uncertain', '临时资料回复已处理，不能重放，请人工核对。');
    }
    // Freeze the exact chunks before any send. Config changes and explicit retries
    // must never reinterpret indexes of already delivered messages.
    const plan = saved.texts !== undefined ? { texts: saved.texts, intervals: saved.intervals }
      : saved.version === 1 ? { texts: splitText(message.text), intervals: splitText(message.text).map(() => 0) }
      : replyPlan(message.text, this.config.segmentedReply, message.replyTo !== undefined ||
        (this.modelSend?.sessionId === message.sessionId && this.modelSend.peer === message.peer && this.modelSend.text === message.text));
    const parts = plan.texts;
    if (!Array.isArray(parts) || !parts.length || parts.length > 64 || parts.some(t => typeof t !== 'string' || !t || Array.from(t).length > 1500)
      || !Array.isArray(plan.intervals) || plan.intervals.length !== parts.length || plan.intervals.some(ms => !Number.isFinite(ms) || ms < 0 || ms > 60000))
      throw new QQError('reply_size', '发送分段记录无效或回复过长，原记录已保留。');
    saved = { version: 1, fingerprint, partCount: parts.length, ...(saved.reportFailure ? { reportFailure: true } : {}),
      ...(message.transient ? { transient: true as const } : { texts: parts, intervals: plan.intervals }), parts: saved.parts ?? [] };
    const ledger = saved as Delivery;
    observe(ledger);
    await this.ctx.config.save(file, ledger);
    for (let i = 0; i < parts.length; i++) {
      signal.throwIfAborted();
      if (ledger.parts[i]?.state === 'sent') continue;
      if (ledger.parts[i]?.state === 'pending') throw new QQError('uncertain', '上次发送结果不确定，已阻止重发，请人工核对。');
      await delay(Math.max(plan.intervals[i], this.config.minReplyIntervalMs - (Date.now() - this.lastSent)), undefined, { signal });
      signal.throwIfAborted();
      ledger.parts[i] = { state: 'pending' };
      try { await this.ctx.config.save(file, ledger); signal.throwIfAborted(); }
      catch (error) { ledger.parts[i] = { state: 'failed', notSent: true }; throw error; }
      let result: Record<string, unknown>;
      try {
        result = await this.bot.request('send_private_msg', {
          user_id: Number.isSafeInteger(Number(target)) ? Number(target) : target, message: [{ type: 'text', data: { text: parts[i] } }], auto_escape: true,
        }, signal);
        // A success envelope without a real platform message ID is not proof of delivery.
        if (result.message_id === undefined || result.message_id === null) throw new QQError('uncertain', '协议端未提供发送消息 ID，请人工核对。');
        const platformId = id(result.message_id);
        if (platformId === '0') throw new QQError('uncertain', '协议端未提供有效的发送消息 ID，请人工核对。');
        ledger.parts[i] = { state: 'sent', messageId: platformId };
        this.lastSent = Date.now();
      } catch (error) {
        if (error instanceof QQError && ['platform_failed', 'offline'].includes(error.code) && !signal.aborted) {
          ledger.parts[i] = { state: 'failed', ...(error.notSent ? { notSent: true as const } : {}) }; await this.ctx.config.save(file, ledger);
        } else if (error instanceof QQError && error.notSent) {
          ledger.parts[i] = { state: 'failed', notSent: true }; await this.ctx.config.save(file, ledger);
        }
        throw error;
      }
      try { await this.ctx.config.save(file, ledger); }
      catch (error) {
        if (i === parts.length - 1) { this.notice('sent_receipt_unavailable', undefined, '平台已确认发送，但插件回执未能保存。'); return; }
        throw new QQError('uncertain', '部分内容已发送，回执保存中断；未发送剩余内容。');
      }
    }
  }
  async recipients(signal: AbortSignal) {
    signal = AbortSignal.any([signal, this.signal]); signal.throwIfAborted();
    let friends: unknown[] = [], contactsAvailable = false;
    try { friends = await this.bot.request('get_friend_list', {}, signal); contactsAvailable = friends.length > 0; }
    catch { signal.throwIfAborted(); /* Allowed IDs remain authoritative when contact lookup is unavailable. */ }
    const clean = (v: unknown) => typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 128) : '';
    return { accountId: this.config.accountId, contactsAvailable, recipients: this.config.allowedUsers
      .filter(userId => userId !== this.config.accountId).map(userId => {
        const friend = friends.map(object).find(f => String(f.user_id) === userId);
        return { userId, nickname: clean(friend?.nickname), remark: clean(friend?.remark), source: 'configured_whitelist' };
      }) };
  }
  async sendText(input: { userId: string; messageId: string; text: string }, options: { signal?: AbortSignal; sessionId?: string; modelGenerated?: boolean; transient?: boolean } = {}) {
    const signal = AbortSignal.any([this.signal, ...(options.signal ? [options.signal] : [])]);
    signal.throwIfAborted();
    const target = account(input.userId);
    if (!this.config.allowedUsers.includes(target)) throw new QQError('peer', '发送对象不在白名单内。');
    if (typeof input.messageId !== 'string' || !input.messageId || input.messageId.length > 200 || typeof input.text !== 'string') throw new QQError('send', '发送参数无效。');
    if (input.text.startsWith('[QQ 临时私聊；正文不留存；')) throw new QQError('input', '正文不能使用插件保留的投递摘要格式。');
    if (options.transient && (!options.modelGenerated || !options.sessionId)) throw new QQError('session', '临时发送缺少可信工具会话。');
    // Direct calls serialize binding + dispatch. A model tool pins its trusted session;
    // ordinary service callers retain the previous follow-Web behavior.
    const task = this.directSending.then(async () => {
      signal.throwIfAborted();
      const peer = `direct:${target}`;
      const guardKey = options.modelGenerated && options.sessionId ? this.bindingKey(peer, options.sessionId) : undefined;
      const blocked = guardKey && this.blockedModelBindings.get(guardKey);
      if (blocked) throw new QQError('binding_retry_blocked', blocked.message);
      try { await this.followCurrentSession(peer, signal, options.sessionId); }
      catch (error) {
        if (guardKey && error instanceof QQError && error.code === 'binding') this.blockedModelBindings.set(guardKey, error);
        throw error;
      }
      signal.throwIfAborted();
      if (options.modelGenerated && options.sessionId) this.modelSend = { sessionId: options.sessionId, peer, text: input.text };
      const text = options.transient ? `[QQ 临时私聊；正文不留存；指纹 ${digest([this.config.accountId, peer, input.messageId, input.text])}]` : input.text;
      if (options.transient) this.transientSend = { sessionId: options.sessionId!, peer, descriptor: text, text: input.text };
      try {
        const result = await this.describeDelivery(await this.channel.send({ peer, messageId: input.messageId, text }, { signal }));
        if (!options.transient) return result;
        const { text: _descriptor, ...receipt } = result;
        return { ...receipt, transient: true as const };
      } finally { this.modelSend = undefined; this.transientSend = undefined; }
    });
    this.directSending = task.catch(() => {});
    return task;
  }
  sendMedia(input: MediaAction, options: MediaSendOptions = {}) {
    const signal = AbortSignal.any([this.signal, ...(options.signal ? [options.signal] : [])]);
    signal.throwIfAborted();
    if (this.mediaActions >= 2) throw new QQError('busy', '图文发送队列已满，未提交。');
    this.mediaActions++;
    const task = this.sending.then(() => this.outboundMedia.execute(input, signal, options.retry === true)).finally(() => { this.mediaActions--; });
    this.sending = task.then(() => {}, () => {});
    return task;
  }
  mediaDelivery(input: MediaKey) { this.signal.throwIfAborted(); return this.outboundMedia.status(input); }
  qzonePublish(input: PublishPayload, options: { signal: AbortSignal }) { return this.space.publish(input, options); }
  async qzoneDescribeImage(input: Parameters<SpaceWebTransport['readImage']>[0], options: { signal: AbortSignal }) {
    const signal = AbortSignal.any([this.signal, options.signal]);
    const image = await this.spaceWeb.readImage(input, { signal });
    const reader = new MediaReader(this.ctx, this.config, this.bot, signal);
    try { return await reader.image({ url: 'base64://' + image.base64 }); }
    finally { await reader.dispose(); }
  }
  status() { return { ...this.state, queued: this.inflight.size + this.mediaActions, recent: this.recent, binding: this.bindingState }; }
  stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    this.stopped = true; this.controller.abort(); this.bot.stop();
    try { this.channel.dispose(); } catch { /* Host may already have revoked this generation. */ }
    this.stopPromise = Promise.allSettled([this.tail, this.directSending, this.sending, this.bindingSync, this.media.dispose()]).then(() => {});
    return this.stopPromise;
  }
}
