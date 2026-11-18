/*! Copyright (c) 2026 iinukami and contributors.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */
import { randomUUID } from 'node:crypto';
import type { Context, OutgoingMessage, ChannelResult } from 'whalelife';
import { digest } from './messages.ts';
import { QQError } from './config.ts';
import { textDeliveryReceipt, unknownDelivery, type Delivery } from './text-delivery.ts';

export type DeliveryKey = { sessionId: string; deliveryId: string };
export type DeliveryDecision = DeliveryKey & { expectedRevision: string };
export type DeliveryList = { sessionId: string; limit?: number; cursor?: string };
export type DeliverySource = { messageId: string; direction: 'in' | 'out' };
interface Entry extends DeliveryKey, DeliverySource {
  version: 1; accountId: string; peer: string; createdAt: string; updatedAt: string;
  revision: string; phase: 'in_progress' | 'settled' | 'dismissed'; hostStatus?: string;
}
type Index = { version: 1; items: DeliveryKey[] };
const cleanId = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 200 && !/[\u0000-\u001f\u007f]/.test(v);
export const blockedTextDelivery = (reason: string) => ({ status: 'blocked' as const, confirmed: false, reason });
const knownErrors = new Set(['invalid_input', 'not_found', 'storage', 'offline', 'permission', 'recipient', 'session_changed',
  'in_progress', 'unknown', 'stale_revision', 'dismissed', 'host_blocked', 'cancelled', 'capacity']);
export function textDeliveryError(error: unknown, signal?: AbortSignal) {
  return blockedTextDelivery(signal?.aborted ? 'cancelled' : error instanceof QQError && knownErrors.has(error.code) ? error.code : 'storage');
}
function fail(code: string): never { throw new QQError(code, `文字续发受阻：${code}。`); }

/** Owns discoverable metadata only. Original text remains in the existing delivery ledger. */
export class TextContinuations {
  private ctx: Context;
  private accountId: string;
  private guard: (entry: Entry) => Promise<string | undefined>;
  private tail: Promise<unknown> = Promise.resolve();
  private active = new Set<string>();
  constructor(ctx: Context, accountId: string, guard: (entry: Entry) => Promise<string | undefined>) {
    this.ctx = ctx; this.accountId = accountId; this.guard = guard;
  }
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const task = this.tail.then(fn); this.tail = task.catch(() => {}); return task;
  }
  private file(deliveryId: string) { return `text-continuation-${digest(deliveryId)}.json`; }
  private async index(): Promise<Index> {
    const value = await this.ctx.config.read<Partial<Index>>(`text-continuations-${digest(this.accountId)}.json`);
    if (!Object.keys(value).length) return { version: 1, items: [] };
    if (value.version !== 1 || !Array.isArray(value.items) || value.items.length > 512 ||
      value.items.some(k => !cleanId(k.sessionId) || !cleanId(k.deliveryId)) || new Set(value.items.map(k => k.deliveryId)).size !== value.items.length) fail('storage');
    return value as Index;
  }
  private saveIndex(index: Index) { return this.ctx.config.save(`text-continuations-${digest(this.accountId)}.json`, index); }
  private validate(key: DeliveryKey, decision = false) {
    if (!key || !cleanId(key.sessionId) || !cleanId(key.deliveryId) || Object.keys(key).some(k =>
      !['sessionId', 'deliveryId', ...(decision ? ['expectedRevision'] : [])].includes(k))) fail('invalid_input');
  }
  private async entry(key: DeliveryKey): Promise<Entry> {
    this.validate({ sessionId: key.sessionId, deliveryId: key.deliveryId });
    const e = await this.ctx.config.read<Partial<Entry>>(this.file(key.deliveryId));
    if (!Object.keys(e).length || e.sessionId !== key.sessionId || e.accountId !== this.accountId) fail('not_found');
    if (e.version !== 1 || e.deliveryId !== key.deliveryId || !cleanId(e.messageId) ||
      !['in', 'out'].includes(e.direction!) || !/^direct:[1-9]\d{4,19}$/.test(e.peer ?? '') ||
      !['in_progress', 'settled', 'dismissed'].includes(e.phase!) || !cleanId(e.revision) ||
      !Number.isFinite(Date.parse(e.createdAt ?? '')) || !Number.isFinite(Date.parse(e.updatedAt ?? ''))) fail('storage');
    return e as Entry;
  }
  private async save(e: Entry) {
    e.updatedAt = new Date().toISOString(); e.revision = randomUUID();
    await this.ctx.config.save(this.file(e.deliveryId), e);
    // Notifications are hints; the durable entry remains authoritative if emit fails.
    try { this.ctx.emit('plugin:qq:text-delivery-changed', { accountId: e.accountId, sessionId: e.sessionId,
      deliveryId: e.deliveryId, revision: e.revision, state: e.phase === 'settled' ? e.hostStatus : e.phase }); } catch { /* no replay */ }
  }
  private async remove(e: Entry) {
    const index = await this.index(); index.items = index.items.filter(k => k.deliveryId !== e.deliveryId); await this.saveIndex(index);
  }
  async begin(message: OutgoingMessage, source: DeliverySource | undefined, fresh: boolean) {
    if (!fresh || !source || message.transient) return;
    await this.serial(async () => {
      const key = { sessionId: message.sessionId, deliveryId: message.deliveryId }; this.validate(key);
      if (!cleanId(source.messageId)) fail('invalid_input');
      const previous = await this.ctx.config.read<Partial<Entry>>(this.file(message.deliveryId));
      if (Object.keys(previous).length) fail('storage');
      const index = await this.index();
      // Only completed/dismissed rows left by an interrupted index write may be pruned.
      let retained = index.items;
      if (retained.length >= 512) {
        retained = [];
        for (const k of index.items) {
          const old = await this.entry(k);
          if (old.phase !== 'dismissed' && old.hostStatus !== 'sent') retained.push(k);
        }
      }
      if (retained.length >= 512) fail('capacity');
      const at = new Date().toISOString();
      const entry: Entry = { version: 1, ...key, ...source, accountId: this.accountId, peer: message.peer,
        createdAt: at, updatedAt: at, revision: randomUUID(), phase: 'in_progress' };
      await this.ctx.config.save(this.file(entry.deliveryId), entry);
      await this.saveIndex({ version: 1, items: [...retained, key] });
      this.active.add(entry.deliveryId);
    });
  }
  async settle(result: ChannelResult) {
    if (!result.deliveryId) return;
    await this.serial(async () => {
      const raw = await this.ctx.config.read<Partial<Entry>>(this.file(result.deliveryId!));
      if (!Object.keys(raw).length) return; // old, acknowledgement or transient delivery
      const e = await this.entry({ sessionId: result.sessionId, deliveryId: result.deliveryId! });
      this.active.delete(e.deliveryId);
      if (e.phase === 'dismissed' || e.hostStatus === 'sent') return;
      // The public host result supplies the authoritative external ID for direct
      // sends. Never make a guessed in-flight adapter association resumable.
      if (e.direction === 'out') {
        if (!cleanId(result.messageId)) fail('storage');
        e.messageId = result.messageId;
      }
      if (e.phase !== 'settled' || e.hostStatus !== result.status) {
        e.phase = 'settled'; e.hostStatus = result.status; await this.save(e);
      }
      if (e.hostStatus === 'sent') await this.remove(e);
    });
  }
  private async snapshot(e: Entry, details: boolean) {
    const ledger = await this.ctx.config.read<Partial<Delivery>>(`delivery-${digest(e.deliveryId)}.json`);
    const valid = ledger.version === 1 && ledger.transient !== true && Array.isArray(ledger.texts) && ledger.texts.length > 0 &&
      ledger.texts.length <= 64 && ledger.texts.every(t => typeof t === 'string' && t.length > 0 && Array.from(t).length <= 1500) &&
      Array.isArray(ledger.intervals) && ledger.intervals.length === ledger.texts.length && ledger.intervals.every(t => Number.isFinite(t) && t >= 0 && t <= 60000) &&
      Array.isArray(ledger.parts) && ledger.parts.length <= ledger.texts.length;
    let delivery = valid ? textDeliveryReceipt(ledger as Delivery) : unknownDelivery();
    if (e.hostStatus === 'sent') delivery = { ...delivery, outcome: 'sent', sentParts: delivery.totalParts,
      notSentParts: 0, unknownParts: 0, unattemptedParts: 0, summary: '主干已记录整份原回复确认发送；发送确认不代表已读。' };
    const state = e.phase === 'dismissed' ? 'dismissed' : e.hostStatus === 'sent' ? 'sent' : e.phase === 'in_progress'
      ? this.active.has(e.deliveryId) ? 'in_progress' : 'unknown'
      : !valid || delivery.unknownParts !== 0 || !['generated', 'delivery_failed'].includes(e.hostStatus ?? '') ? 'unknown' : 'incomplete';
    const reason = state === 'sent' ? undefined : state === 'dismissed' ? 'dismissed' : state === 'in_progress' ? 'in_progress'
      : state === 'unknown' ? 'unknown' : await this.guard(e);
    return { deliveryId: e.deliveryId, accountId: e.accountId, sessionId: e.sessionId, userId: e.peer.slice(7),
      direction: e.direction, createdAt: e.createdAt, updatedAt: e.updatedAt, revision: e.revision,
      state, canResume: state === 'incomplete' && !reason, ...(reason ? { blockedReason: reason } : {}), delivery,
      ...(details && valid ? { parts: ledger.texts!.map((text, i) => {
        const p = ledger.parts![i]; const sent = p?.state === 'sent' && typeof p.messageId === 'string' && /^-?\d{1,20}$/.test(p.messageId) && BigInt(p.messageId) !== 0n;
        return { text, state: sent ? 'sent' : i >= ledger.parts!.length || (p?.state === 'failed' && p.notSent === true) ? 'not_sent' : 'unknown',
          ...(sent ? { messageId: p.messageId } : {}) };
      }) } : {}),
    };
  }
  async get(key: DeliveryKey) { this.validate(key); return this.serial(async () => ({ status: 'ok' as const, item: await this.snapshot(await this.entry(key), true) })); }
  async list(input: DeliveryList) {
    return this.serial(async () => {
      if (!input || Object.keys(input).some(k => !['sessionId', 'limit', 'cursor'].includes(k)) || !cleanId(input.sessionId) || (input.limit !== undefined && (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 50)) ||
        (input.cursor !== undefined && !/^[a-f0-9]{64}$/.test(input.cursor))) fail('invalid_input');
      const index = await this.index(), entries: Entry[] = [];
      for (const key of index.items.filter(k => k.sessionId === input.sessionId)) {
        const e = await this.entry(key); if (e.phase !== 'dismissed' && e.hostStatus !== 'sent') entries.push(e);
      }
      entries.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.deliveryId.localeCompare(b.deliveryId));
      // A changed page boundary returns stale_revision; callers restart the snapshot.
      const ordered = entries.map(e => ({ e, cursor: digest([e.createdAt, e.deliveryId]) }));
      let start = 0;
      if (input.cursor) { const i = ordered.findIndex(v => v.cursor === input.cursor); if (i < 0) fail('stale_revision'); start = i + 1; }
      const page = ordered.slice(start, start + (input.limit ?? 20));
      const items = []; for (const { e } of page) items.push(await this.snapshot(e, false));
      return { status: 'ok' as const, items, ...(start + page.length < ordered.length ? { nextCursor: page.at(-1)!.cursor } : {}) };
    });
  }
  async claim(input: DeliveryDecision) {
    this.validate(input, true);
    return this.serial(async () => {
      const e = await this.entry(input), item = await this.snapshot(e, true);
      if (item.state === 'sent') return { item };
      if (!cleanId(input.expectedRevision) || input.expectedRevision !== e.revision) fail('stale_revision');
      if (!item.canResume) fail(item.blockedReason ?? 'unknown');
      e.phase = 'in_progress'; await this.save(e); this.active.add(e.deliveryId);
      return { item, entry: e };
    });
  }
  async hostBlocked(key: DeliveryKey) {
    await this.serial(async () => { const e = await this.entry(key); this.active.delete(e.deliveryId);
      if (e.hostStatus === 'sent' || e.phase === 'dismissed') return;
      e.phase = 'settled'; e.hostStatus = 'uncertain'; await this.save(e); });
  }
  async dismiss(input: DeliveryDecision) {
    this.validate(input, true);
    return this.serial(async () => {
      const e = await this.entry(input);
      if (!cleanId(input.expectedRevision) || input.expectedRevision !== e.revision) fail('stale_revision');
      if (this.active.has(e.deliveryId)) fail('in_progress');
      if (e.hostStatus !== 'sent' && e.phase !== 'dismissed') { e.phase = 'dismissed'; await this.save(e); }
      await this.remove(e);
      const item = await this.snapshot(e, true);
      return { status: e.hostStatus === 'sent' ? 'sent' as const : 'dismissed' as const, confirmed: e.hostStatus === 'sent', item };
    });
  }
}
