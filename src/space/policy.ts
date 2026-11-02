import { QQError } from '../config.ts';
export const QZONE_LIMITS = { text: 10000, images: 8, bytes: 25 * 1024 * 1024, pixels: 40000000 } as const;
export function sessionId(v: unknown): string {
  if (typeof v !== 'string' || !v || v.length > 200 || /[\u0000-\u001f\u007f]/.test(v)) throw new QQError('session', '缺少可信会话。');
  return v;
}
