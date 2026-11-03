/*! Copyright (c) 2026 iinukami and contributors.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */
export interface Delivery {
  version: 1; fingerprint: string; transient?: true; partCount?: number; texts?: string[]; intervals?: number[];
  reportFailure?: boolean;
  parts: { state: 'pending' | 'sent' | 'failed'; messageId?: string; notSent?: true }[];
}
export interface TextDeliveryReceipt {
  outcome: 'not_sent' | 'partial' | 'unknown' | 'sent';
  scope: 'action' | 'current_call';
  totalParts: number | null; sentParts: number | null; notSentParts: number | null; unknownParts: number | null;
  unattemptedParts: number | null;
  readStatus: 'unknown'; summary: string;
}
export function unknownDelivery(): TextDeliveryReceipt {
  return { outcome: 'unknown', scope: 'action', totalParts: null, sentParts: 0, notSentParts: null,
    unknownParts: null, unattemptedParts: null, readStatus: 'unknown',
    summary: '缺少可信的逐段投递记录，发送结果未知；不能据此判断对方是否收到、已读或愿意回复。不要自动重发。' };
}
export function blockedDelivery(): TextDeliveryReceipt {
  return { ...unknownDelivery(), outcome: 'not_sent', scope: 'current_call', unknownParts: 0,
    summary: '本次调用在提交发送前被阻止；不代表同一动作以前未发送。没有对方已读或态度的证据。' };
}
export function textDeliveryReceipt(ledger: Delivery): TextDeliveryReceipt {
  const total = ledger.texts?.length ?? ledger.partCount;
  if (!Number.isInteger(total) || total! < 0 || total! > 64 || !Array.isArray(ledger.parts) || ledger.parts.length > total!) return unknownDelivery();
  let sent = 0, unknown = 0, unattempted = 0;
  for (let i = 0; i < total!; i++) {
    const part = ledger.parts[i];
    if (!part) unattempted++;
    else if (part.state === 'sent' && typeof part.messageId === 'string' && /^-?\d{1,20}$/.test(part.messageId) && BigInt(part.messageId) !== 0n) sent++;
    else if (!(part.state === 'failed' && part.notSent === true)) unknown++;
  }
  const notSent = total! - sent - unknown;
  const outcome = total! > 0 && sent === total ? 'sent' : sent > 0 ? 'partial' : unknown > 0 ? 'unknown' : 'not_sent';
  const summary = outcome === 'sent' ? `QQ 平台已确认全部 ${total} 段发送；发送确认不代表对方已读。`
    : `QQ 投递${outcome === 'not_sent' ? '明确未发出' : outcome === 'partial' ? '部分完成' : '结果未知'}：共 ${total} 段，确认发送 ${sent} 段，明确未发送 ${notSent} 段（其中 ${unattempted} 段未提交），结果未知 ${unknown} 段。没有对方已读或不愿回复的证据。不要自动重发或更换动作 ID 重试。`;
  return { outcome, scope: 'action', totalParts: total!, sentParts: sent, notSentParts: notSent, unknownParts: unknown,
    unattemptedParts: unattempted, readStatus: 'unknown', summary };
}
