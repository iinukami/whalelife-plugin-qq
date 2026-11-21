/*! Copyright (c) 2026 iinukami and contributors.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */
import { setTimeout as delay } from 'node:timers/promises';
import type { Context, ChannelHandle, ChannelTurn, OutgoingMessage, ToolSession } from 'whalelife';
import { object, account, id, safeError, QQError, type Config } from './config.ts';
import { TemporaryDrafts, type DraftKey } from './temporary-drafts.ts';
import { OneBot, type LinkState } from './onebot.ts';
import { MediaReader } from './media.ts';
import { privateEvent, digest, splitText, type PrivateEvent } from './messages.ts';
import { replyPlan } from './segmentation.ts';
import { InboundMedia } from './inbound-media.ts';
import { GroupSubscription } from './group-subscription.ts';
import { GroupConnection } from './group-connection.ts';
import { OutboundMedia, type MediaAction, type MediaKey, type MediaSendOptions } from './outbound-media.ts';
import { OutboundMiniApp, miniAppFailure, type MiniAppShare, type MiniAppKey, type MiniAppOptions } from './outbound-miniapp.ts';
import { prepareVideoCard, type ShareMessage } from './video-share.ts';
import { SpaceTransport } from './space/transport.ts';
import { SpaceWebTransport } from './space/web-transport.ts';
import type { PublishPayload } from './space/types.ts';
import { textDeliveryReceipt, unknownDelivery, type Delivery, type TextDeliveryReceipt } from './text-delivery.ts';
import { TextContinuations, textDeliveryError, blockedTextDelivery, type DeliveryKey, type DeliveryList, type DeliveryDecision, type DeliverySource } from './text-continuation.ts';

interface Inbox { version: 1; fingerprint: string; state: 'preparing' | 'ready' | 'failed'; text?: string; sessionId?: string; }
type IncomingBinding = { peer: string; sessionId: string; messageId: string };
type TurnResult = Awaited<ReturnType<ChannelHandle['receive']>>;
type ActiveTurn = { handle: ChannelTurn; result: Promise<TurnResult> };
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
  private admissions = new Map<string, Promise<void>>();
  private pending = new Set<Promise<void>>();
  private turns = new Map<string, ActiveTurn>();
  private opening = new Map<string, Promise<ActiveTurn>>();
  private sending: Promise<void> = Promise.resolve();
  private directSending: Promise<unknown> = Promise.resolve();
  private bindingSync?: Promise<void>;
  private inboundMedia: InboundMedia;
  private groupSubscription: GroupSubscription;
  readonly groups: GroupConnection;
  private outboundMedia: OutboundMedia;
  private outboundMiniApp: OutboundMiniApp;
  private miniAppSending: Promise<void> = Promise.resolve();
  private miniAppActions = 0;
  private mediaActions = 0;
  private incomingBindings = new Map<string, IncomingBinding>();
  private blockedModelBindings = new Map<string, QQError>();
  private bindingState: { state: 'waiting' | 'ready'; sessionId?: string; error?: string } = { state: 'waiting' };
  private modelSend?: { sessionId: string; peer: string; text: string };
  // Only the redacted descriptor enters the public channel's durable dedup index.
  // This descriptor cannot replay the original. Only a live send may offer its unsent tail.
  private temporaryDrafts = new TemporaryDrafts();
  private transientSend?: { sessionId: string; peer: string; descriptor: string; text: string; allowDraft: boolean };
  private inflight = new Set<string>();
  private lastSent = 0;
  private deliveryResults = new Map<string, TextDeliveryReceipt>();
  private continuations: TextContinuations;
  private directTextSource?: DeliverySource & { peer: string; sessionId: string; text: string };
  private resumingText?: { deliveryId: string; sessionId: string };
  private stopped = false;
  private stopPromise?: Promise<void>;
  state: LinkState = { state: 'disconnected' };
  recent: Notice[] = [];
  constructor(ctx: Context, config: Config, inboundMedia = new InboundMedia(), groupSubscription = new GroupSubscription()) {
    this.ctx = ctx; this.config = config;
    this.groupSubscription = groupSubscription;
    this.inboundMedia = inboundMedia;
    this.signal = AbortSignal.any([ctx.signal, this.controller.signal]);
    this.continuations = new TextContinuations(ctx, config.accountId, async entry => {
      if (this.signal.aborted || this.stopped) return 'cancelled';
      if (this.state.state !== 'online') return 'offline';
      if (this.config.permission !== 'full') return 'permission';
      if (!this.config.allowedUsers.includes(entry.peer.slice(7)) || entry.peer === `direct:${this.config.accountId}`) return 'recipient';
      if (this.incomingBindings.has(entry.peer) || this.turns.has(entry.peer) || this.opening.has(entry.peer)) return 'in_progress';
      try {
        if (typeof ctx.sessions.current !== 'function') return 'host_blocked';
        if (await ctx.sessions.current() !== entry.sessionId || (await this.channel.context(entry.peer)).id !== entry.sessionId) return 'session_changed';
      } catch { return 'host_blocked'; }
    });
    this.bot = new OneBot(config, this.signal, event => this.accept(event), state => {
      const changed = this.state.state !== state.state; this.state = state;
      if (changed && !this.signal.aborted) {
        try { ctx.emit('plugin:qq:connection-changed', { accountId: config.accountId, state: state.state }); } catch { /* notifications are advisory */ }
      }
    });
    this.groups = new GroupConnection(ctx, config, this.bot, groupSubscription, this.signal, (groupId, message, signal, beforeSubmit) => {
      const task = this.sending.then(async () => {
        await delay(Math.max(0, config.minReplyIntervalMs - (Date.now() - this.lastSent)), undefined, { signal });
        if (this.state.state !== 'online') throw new QQError('offline', 'QQ 尚未在线。', true);
        await beforeSubmit();
        const result = await this.bot.request('send_group_msg', {
          group_id: Number.isSafeInteger(Number(groupId)) ? Number(groupId) : groupId, message, auto_escape: true,
        }, signal);
        const messageId = id(result.message_id);
        if (messageId === '0') throw new QQError('uncertain', '协议端未提供有效的群消息 ID。');
        this.lastSent = Date.now();
        return messageId;
      });
      this.sending = task.then(() => {}, () => {});
      return task;
    });
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
    const submitShare = (userId: string, message: ShareMessage, signal: AbortSignal,
      markPending: () => Promise<void>, markDispatched: () => void) => {
        // Signing must not occupy the ordinary delivery queue. Only a ready
        // card joins it, preserving whole segmented replies and rate limits.
        const task = this.sending.then(async () => {
          await delay(Math.max(0, this.config.minReplyIntervalMs - (Date.now() - this.lastSent)), undefined, { signal });
          signal.throwIfAborted();
          await markPending(); signal.throwIfAborted();
          if (this.state.state !== 'online') throw new QQError('offline', 'QQ 尚未在线，未发送。', true);
          markDispatched();
          const result = await this.bot.request('send_private_msg', {
            user_id: Number.isSafeInteger(Number(userId)) ? Number(userId) : userId,
            message, auto_escape: true,
          }, signal);
          const messageId = id(result.message_id);
          if (messageId === '0') throw new QQError('uncertain', '协议端未提供有效消息 ID，结果不确定。');
          this.lastSent = Date.now(); return messageId;
        });
        this.sending = task.then(() => {}, () => {}); return task;
      };
    this.outboundMiniApp = new OutboundMiniApp(ctx, config,
      (params, signal) => this.bot.request('get_mini_app_ark', params, signal),
      (userId, ark, signal, pending, dispatched) => submitShare(userId, [{ type: 'json', data: { data: ark } }], signal, pending, dispatched),
      { prepare: (input, signal) => prepareVideoCard(input, config, signal), submit: submitShare });
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
              if (this.incomingBindings.size) {
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
    const incoming = this.incomingBindings.get(peer);
    if (incoming && incoming.sessionId !== sessionId)
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
    if (raw.message_type === 'group' || raw.post_type === 'notice') {
      this.groupSubscription.offer(raw, this.config.accountId, this.signal);
      return;
    }
    let event: PrivateEvent | null;
    try { event = privateEvent(raw, this.config); }
    catch (error) { this.notice('invalid_event', undefined, safeError(error)); return; }
    if (!event) return;
    const key = `${event.peer}/${event.messageId}`;
    if (this.inflight.has(key)) return;
    if (this.inflight.size >= 64) { this.notice('busy', event.messageId, '待处理私聊过多，本条未接收。'); return; }
    this.inflight.add(key);
    const merging = this.config.mergeIncoming && typeof this.channel.openTurn === 'function';
    // Admission must never wait for the model result. Serialize preparation per
    // peer, including the opening RPC, so arrivals cannot create competing turns.
    const admission = (merging ? this.admissions.get(event.peer) ?? Promise.resolve() : this.tail).then(async () => {
      this.signal.throwIfAborted();
      return this.receive(event!, merging);
    });
    const task = admission.then(value => value.completion).catch(error => {
      if (!this.signal.aborted) this.notice('failed', event!.messageId, safeError(error));
    }).finally(() => { this.inflight.delete(key); });
    if (merging) {
      const ready = admission.then(() => {}, () => {});
      this.admissions.set(event.peer, ready);
      void ready.then(() => { if (this.admissions.get(event!.peer) === ready) this.admissions.delete(event!.peer); });
    } else this.tail = task;
    this.pending.add(task);
    void task.then(() => this.pending.delete(task));
  }
  private async receive(event: PrivateEvent, merging: boolean): Promise<{ completion: Promise<void> }> {
    const file = `inbox-${digest([this.config.accountId, event.peer, event.messageId])}.json`;
    let saved = await this.ctx.config.read<Partial<Inbox>>(file);
    this.signal.throwIfAborted();
    if (saved.version !== undefined && saved.version !== 1) throw new QQError('state_version', '收件状态版本不受支持，原数据已保留。');
    if (saved.sessionId !== undefined && (typeof saved.sessionId !== 'string' || !saved.sessionId || saved.sessionId.length > 200))
      throw new QQError('state', '收件会话记录无效，原数据已保留。');
    if (saved.fingerprint && saved.fingerprint !== event.fingerprint) throw new QQError('duplicate_conflict', '同一消息 ID 的内容发生变化，已拒绝处理。');
    if (saved.state === 'preparing' || saved.state === 'failed') {
      this.notice('uncertain', event.messageId, '这条消息的识别曾中断或失败，未自动重做。请修正配置后以新消息重发。'); return { completion: Promise.resolve() };
    }
    let offeredReference = false;
    const normalize = async (sessionId?: string) => {
      saved = { version: 1, fingerprint: event.fingerprint, state: 'preparing', ...(sessionId ? { sessionId } : {}) };
      await this.ctx.config.save(file, saved);
      try {
        const text = await this.media.normalize(event, sessionId ? async (bytes, mime, imageIndex) => {
          const reference = await this.inboundMedia.offer({
            sessionId, messageId: event.messageId, imageIndex, mime, base64: bytes.toString('base64'),
          }, this.signal);
          offeredReference ||= reference.startsWith('[原图引用 ');
          return reference;
        } : undefined);
        this.signal.throwIfAborted();
        saved = { ...saved, state: 'ready', text };
        await this.ctx.config.save(file, saved);
      } catch (error) {
        if (!this.signal.aborted) await this.ctx.config.save(file, { ...saved, state: 'failed' });
        throw error;
      }
    };
    const report = async (value: TurnResult) => {
      const result = await this.describeDelivery(value);
      this.notice(result.status, event.messageId, result.delivery.summary);
    };
    const active = merging ? this.turns.get(event.peer) : undefined;
    if (active) {
      if (!saved.sessionId || saved.sessionId === active.handle.sessionId) {
        const preparedForAppend = saved.state !== 'ready';
        if (preparedForAppend) await normalize(active.handle.sessionId);
        if (typeof saved.text !== 'string') throw new QQError('state', '收件记录不完整，已停止处理。');
        this.signal.throwIfAborted();
        const added = await active.handle.append({ peer: event.peer, sender: event.sender, messageId: event.messageId, text: saved.text });
        if (added.status === 'accepted' || added.status === 'duplicate') {
          this.notice('merged', event.messageId);
          return { completion: active.result.then(report) };
        }
        if (added.status === 'cancelled') throw new QQError('cancelled', '本轮已取消，这条补充未接纳，不自动重试。');
        // closed/full explicitly mean not admitted. Wait for delivery and binding
        // release, then open a fresh turn with this very message (never drop it).
        this.notice('next_turn', event.messageId);
        // Rejected text-only additions follow the next current session. Keep
        // session-bound media references pinned rather than moving their access.
        if (preparedForAppend && !offeredReference) {
          delete saved.sessionId;
          await this.ctx.config.save(file, saved);
        }
      }
      await active.result;
      this.signal.throwIfAborted();
    }
    // Preserve the old selection timing when the optional media receiver is absent.
    if (saved.state !== 'ready' && !this.inboundMedia.active()) await normalize();
    // Serialize only route preparation, never the model round: a tool in this round
    // may call sendText and must not wait behind the round that is calling it.
    const prepare = this.directSending.then(async () => {
      await this.followCurrentSession(event.peer, this.signal, saved.sessionId);
      const sessionId = (await this.channel.context(event.peer)).id;
      this.signal.throwIfAborted();
      return sessionId;
    });
    this.directSending = prepare.catch(() => {});
    const sessionId = await prepare;
    const binding = { peer: event.peer, sessionId, messageId: event.messageId };
    this.incomingBindings.set(event.peer, binding);
    const release = () => { if (this.incomingBindings.get(event.peer) === binding) this.incomingBindings.delete(event.peer); };
    try {
      if (saved.state !== 'ready') await normalize(sessionId);
      if (typeof saved.text !== 'string') throw new QQError('state', '收件记录不完整，已停止处理。');
      this.signal.throwIfAborted();
      const message = { peer: event.peer, sender: event.sender, messageId: event.messageId, text: saved.text };
      if (!merging) return { completion: this.channel.receive(message, { signal: this.signal }).then(report).finally(release) };
      const opening = this.channel.openTurn!(message, { signal: this.signal }).then(handle => {
        const turn: ActiveTurn = { handle, result: handle.result().finally(() => {
          if (this.turns.get(event.peer) === turn) this.turns.delete(event.peer);
          release();
        }) };
        if (!handle.duplicate) this.turns.set(event.peer, turn);
        return turn;
      });
      this.opening.set(event.peer, opening);
      let turn: ActiveTurn;
      try { turn = await opening; }
      finally { if (this.opening.get(event.peer) === opening) this.opening.delete(event.peer); }
      return { completion: turn.result.then(report) };
    } catch (error) { release(); throw error; }
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
    // The host has finished saving its result before a continuation becomes eligible.
    await this.continuations.settle(result).catch(() => this.notice('continuation_storage', undefined, '续发状态未能保存；不会自动补发。'));
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
    const fresh = Object.keys(saved).length === 0;
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
    await this.continuations.begin(message, message.replyTo !== undefined
      ? { messageId: message.replyTo, direction: 'in' }
      : this.directTextSource?.peer === message.peer && this.directTextSource.sessionId === message.sessionId && this.directTextSource.text === message.text
        ? { messageId: this.directTextSource.messageId, direction: 'out' } : undefined, fresh);
    // A generic failed envelope is as ambiguous as pending. Never retry it.
    if (textDeliveryReceipt(ledger).unknownParts !== 0)
      throw new QQError('uncertain', '已有分段结果不确定，已阻止续发，请核对。');
    for (let i = 0; i < parts.length; i++) {
      signal.throwIfAborted();
      if (ledger.parts[i]?.state === 'sent') continue;
      if (ledger.parts[i]?.state === 'pending') throw new QQError('uncertain', '上次发送结果不确定，已阻止重发，请人工核对。');
      await delay(Math.max(plan.intervals[i], this.config.minReplyIntervalMs - (Date.now() - this.lastSent)), undefined, { signal });
      signal.throwIfAborted();
      if (this.resumingText?.deliveryId === message.deliveryId) {
        if (this.config.permission !== 'full' || !this.config.allowedUsers.includes(target) ||
          await this.ctx.sessions.current() !== this.resumingText.sessionId)
          throw new QQError('session_changed', '续发条件已改变，剩余内容未发送。', true);
        signal.throwIfAborted();
      }
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
          ledger.parts[i] = { state: 'failed', ...(error.notSent ? { notSent: true as const } : {}) };
          await this.ctx.config.save(file, ledger);
          const live = this.transientSend;
          if (error.notSent && fresh && !signal.aborted && message.transient && message.replyTo === undefined &&
            live?.allowDraft && live.peer === message.peer && live.sessionId === message.sessionId && live.text === message.text) {
            this.temporaryDrafts.offer({ sessionId: message.sessionId, accountId: this.config.accountId, deliveryId: message.deliveryId },
              target, parts, ledger);
          }
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
  acknowledge(text: string, session: ToolSession) {
    const incoming = this.incomingBindings.get(session.peer ?? '');
    // Bind the early reply to this live inbound turn, never a guessed recipient,
    // Web selection or a queued/new message in the same shared session.
    if (!incoming || session.channel !== 'qq' || session.account !== this.config.accountId
      || session.peer !== incoming.peer || session.id !== incoming.sessionId || session.sender !== incoming.peer.slice(7))
      throw new QQError('reply_context', '没有匹配的当前 QQ 来信，未发送接话；网页和自主任务不能使用此入口。');
    return this.sendText({ userId: incoming.peer.slice(7), text,
      messageId: `ack:${digest([this.config.accountId, incoming.peer, incoming.messageId])}` },
    { sessionId: incoming.sessionId, signal: session.signal, modelGenerated: true, transient: session.transientContext === true, acknowledgement: true });
  }
  private async closeReplyInput(peer: string, sessionId?: string) {
    const turn = this.turns.get(peer) ?? await this.opening.get(peer);
    if (turn && turn.handle.sessionId === sessionId) await turn.handle.closeInput();
  }
  async sendText(input: { userId: string; messageId: string; text: string }, options: { signal?: AbortSignal; sessionId?: string; modelGenerated?: boolean; transient?: boolean; acknowledgement?: boolean } = {}) {
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
      if (!options.acknowledgement) await this.closeReplyInput(peer, options.sessionId ?? this.incomingBindings.get(peer)?.sessionId);
      const sourceSessionId = options.acknowledgement || options.transient ? undefined : (await this.channel.context(peer)).id;
      if (options.modelGenerated && options.sessionId) this.modelSend = { sessionId: options.sessionId, peer, text: input.text };
      const text = options.transient ? `[QQ 临时私聊；正文不留存；指纹 ${digest([this.config.accountId, peer, input.messageId, input.text])}]` : input.text;
      if (options.transient) this.transientSend = { sessionId: options.sessionId!, peer, descriptor: text, text: input.text, allowDraft: !options.acknowledgement };
      this.directTextSource = options.acknowledgement || options.transient ? undefined : {
        messageId: input.messageId, direction: 'out', peer, sessionId: sourceSessionId!, text: input.text,
      };
      try {
        const result = await this.describeDelivery(await this.channel.send({ peer, messageId: input.messageId, text }, { signal }));
        if (!options.transient) return result;
        const { text: _descriptor, ...receipt } = result;
        return { ...receipt, transient: true as const };
      } finally { this.modelSend = undefined; this.transientSend = undefined; this.directTextSource = undefined; }
    });
    this.directSending = task.catch(() => {});
    return task;
  }
  claimTemporaryDraft(key: DraftKey) {
    return this.temporaryDrafts.claim(key, userId => !this.signal.aborted && this.config.permission === 'full' &&
      this.config.accountId === key.accountId && this.config.allowedUsers.includes(userId));
  }
  releaseTemporaryDraft(key: DraftKey) { return this.temporaryDrafts.release(key); }
  async listTextDeliveries(input: DeliveryList) {
    try { this.signal.throwIfAborted(); return await this.continuations.list(input); }
    catch (error) { return textDeliveryError(error, this.signal); }
  }
  async textDelivery(input: DeliveryKey) {
    try { this.signal.throwIfAborted(); return await this.continuations.get(input); }
    catch (error) { return textDeliveryError(error, this.signal); }
  }
  async dismissTextDelivery(input: DeliveryDecision) {
    try { this.signal.throwIfAborted(); return await this.continuations.dismiss(input); }
    catch (error) { return textDeliveryError(error, this.signal); }
  }
  resumeTextDelivery(input: DeliveryDecision, options: { signal: AbortSignal }) {
    if (!options?.signal || typeof options.signal.addEventListener !== 'function') return Promise.resolve(blockedTextDelivery('invalid_input'));
    const signal = AbortSignal.any([this.signal, options.signal]);
    const task = this.directSending.then(async () => {
      let claimed = false, confirmed = false;
      try {
        signal.throwIfAborted();
        const claim = await this.continuations.claim(input);
        if (!claim.entry) return { status: 'sent' as const, confirmed: true, item: claim.item };
        claimed = true; this.resumingText = { deliveryId: claim.entry.deliveryId, sessionId: claim.entry.sessionId }; signal.throwIfAborted();
        // Never rebind or call the model here. Core retains its own lease/receipt checks.
        const result = await this.channel.retry(claim.entry.peer, claim.entry.messageId, { direction: claim.entry.direction, signal });
        confirmed = result.status === 'sent';
        await this.describeDelivery(result);
        const detail = await this.continuations.get({ sessionId: input.sessionId, deliveryId: input.deliveryId });
        return { status: detail.item.state === 'sent' ? 'sent' as const : 'incomplete' as const,
          confirmed: detail.item.state === 'sent', item: detail.item };
      } catch (error) {
        if (confirmed) return { status: 'sent' as const, confirmed: true, receiptUnavailable: true };
        if (claimed) {
          await this.continuations.hostBlocked(input).catch(() => {});
          return blockedTextDelivery(signal.aborted ? 'cancelled' : 'host_blocked');
        }
        return textDeliveryError(error, signal);
      } finally { this.resumingText = undefined; }
    });
    this.directSending = task.catch(() => {}); return task;
  }
  sendMedia(input: MediaAction, options: MediaSendOptions = {}) {
    const signal = AbortSignal.any([this.signal, ...(options.signal ? [options.signal] : [])]);
    signal.throwIfAborted();
    if (this.mediaActions >= 2) throw new QQError('busy', '媒体发送队列已满，未提交。');
    this.mediaActions++;
    const task = this.sending.then(() => this.outboundMedia.execute(input, signal, options.retry === true,
      () => this.closeReplyInput(`direct:${input.userId}`, input.sessionId))).finally(() => { this.mediaActions--; });
    this.sending = task.then(() => {}, () => {});
    return task;
  }
  mediaDelivery(input: MediaKey) { this.signal.throwIfAborted(); return this.outboundMedia.status(input); }
  sendMiniAppShare(input: MiniAppShare, options: MiniAppOptions) { return this.sendShare(input, options, false); }
  sendVideoShare(input: MiniAppShare, options: MiniAppOptions) { return this.sendShare(input, options, true); }
  private sendShare(input: MiniAppShare, options: MiniAppOptions, followSelection: boolean) {
    const format = followSelection ? this.config.videoShareFormat : 'miniapp';
    const signal = AbortSignal.any([this.signal, ...(options?.signal ? [options.signal] : [])]);
    if (signal.aborted) return Promise.resolve(miniAppFailure('cancelled'));
    if (this.miniAppActions >= 2) return Promise.resolve(miniAppFailure('busy'));
    this.miniAppActions++;
    const guard = async () => {
      signal.throwIfAborted();
      if (this.state.state !== 'online') throw new QQError('offline', 'QQ 尚未在线，未发送。', true);
      const peer = `direct:${input.userId}`;
      const incoming = this.incomingBindings.get(peer);
      if (incoming && incoming.sessionId !== input.sessionId)
        throw new QQError('binding', '该好友正在处理另一会话，本次未发送。', true);
    };
    const task = this.miniAppSending.then(() => this.outboundMiniApp.execute(input, options, signal, guard,
      () => this.closeReplyInput(`direct:${input.userId}`, input.sessionId), format, followSelection))
      .finally(() => { this.miniAppActions--; });
    this.miniAppSending = task.then(() => {}, () => {}); return task;
  }
  miniAppShareDelivery(input: MiniAppKey) { return this.outboundMiniApp.status(input, this.signal); }
  videoShareDelivery(input: MiniAppKey) { return this.outboundMiniApp.status(input, this.signal, true); }
  qzonePublish(input: PublishPayload, options: { signal: AbortSignal }) { return this.space.publish(input, options); }
  async qzoneDescribeImage(input: Parameters<SpaceWebTransport['readImage']>[0], options: { signal: AbortSignal }) {
    const signal = AbortSignal.any([this.signal, options.signal]);
    const image = await this.spaceWeb.readImage(input, { signal });
    const reader = new MediaReader(this.ctx, this.config, this.bot, signal);
    try { return await reader.image({ url: 'base64://' + image.base64 }); }
    finally { await reader.dispose(); }
  }
  status() { return { ...this.state, queued: this.inflight.size + this.mediaActions + this.miniAppActions, recent: this.recent, binding: this.bindingState,
    incomingMerge: { enabled: this.config.mergeIncoming, supported: typeof this.channel.openTurn === 'function' } }; }
  stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    this.stopped = true; this.controller.abort(); this.temporaryDrafts.clear(); this.bot.stop();
    try { this.channel.dispose(); } catch { /* Host may already have revoked this generation. */ }
    this.stopPromise = Promise.allSettled([...this.pending, this.tail, this.directSending, this.sending, this.miniAppSending, this.bindingSync, this.media.dispose()]).then(() => {});
    return this.stopPromise;
  }
}
