/*! Copyright (c) 2026 iinukami and contributors.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */
import { QQError } from '../config.ts';
export const QZONE_LIMITS = { text: 10000, images: 8, bytes: 25 * 1024 * 1024, pixels: 40000000 } as const;
export function sessionId(v: unknown): string {
  if (typeof v !== 'string' || !v || v.length > 200 || /[\u0000-\u001f\u007f]/.test(v)) throw new QQError('session', '缺少可信会话。');
  return v;
}
