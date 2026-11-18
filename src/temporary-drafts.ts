/*! Copyright (c) 2026 iinukami and contributors.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */
import { textDeliveryReceipt, type Delivery } from './text-delivery.ts';

export type DraftKey = { sessionId: string; accountId: string; deliveryId: string };
type Part = { index: number; text: string };
type Entry = { userId: string; parts?: Part[]; expiresAt: number; timer: NodeJS.Timeout };
const lifetime = 12 * 60 * 60 * 1000;
const capacity = 32;
function mapKey(key: DraftKey) {
  if (!key || Object.keys(key).some(k => !['sessionId', 'accountId', 'deliveryId'].includes(k))) return;
  if (![key.sessionId, key.accountId, key.deliveryId].every(v => typeof v === 'string' && v.length > 0 && v.length <= 200)) return;
  return JSON.stringify([key.sessionId, key.accountId, key.deliveryId]);
}

/** Owns only the unsent portion of live transient replies, scoped to one QQ runtime. */
export class TemporaryDrafts {
  private entries = new Map<string, Entry>();

  offer(key: DraftKey, userId: string, texts: string[], ledger: Delivery) {
    const id = mapKey(key);
    if (!id || this.entries.has(id) || ledger.version !== 1 || !ledger.transient ||
      ledger.partCount !== texts.length || ledger.texts !== undefined || !texts.length) return;
    const receipt = textDeliveryReceipt(ledger);
    if (receipt.unknownParts !== 0 || !receipt.notSentParts) return;
    const parts: Part[] = [];
    for (const [i, text] of texts.entries()) {
      if (typeof text !== 'string' || !text.length) return;
      if (ledger.parts[i]?.state !== 'sent') parts.push({ index: i + 1, text });
    }
    if (this.entries.size >= capacity) this.remove(this.entries.keys().next().value!);
    const expiresAt = Date.now() + lifetime;
    const timer = setTimeout(() => this.remove(id), lifetime);
    timer.unref();
    this.entries.set(id, { userId, parts, expiresAt, timer });
  }

  claim(key: DraftKey, allowed: (userId: string) => boolean) {
    const id = mapKey(key);
    const entry = id && this.entries.get(id);
    if (!entry || !entry.parts) return { status: 'unavailable' as const };
    if (entry.expiresAt <= Date.now() || !allowed(entry.userId)) {
      this.remove(id!);
      return { status: 'unavailable' as const };
    }
    const parts = entry.parts;
    delete entry.parts; // Consume before crossing the service boundary, even if the caller disconnects.
    return { status: 'claimed' as const, ...key, userId: entry.userId, expiresAt: new Date(entry.expiresAt).toISOString(), parts };
  }

  release(key: DraftKey) {
    const id = mapKey(key);
    return { status: id && this.remove(id) ? 'released' as const : 'unavailable' as const };
  }

  private remove(id: string) {
    const entry = this.entries.get(id);
    if (!entry) return false;
    clearTimeout(entry.timer);
    return this.entries.delete(id);
  }

  clear() { for (const id of this.entries.keys()) this.remove(id); }
}
