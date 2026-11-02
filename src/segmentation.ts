import { Script } from 'node:vm';
import { QQError, type SegmentedReply } from './config.ts';
import { splitText } from './messages.ts';

// Patterns are data, never interpolated JavaScript. A bounded VM also interrupts
// pathological regex backtracking before it can stall the plugin's event loop.
const segmentScript = new Script(`(() => {
  const parts = []; let cursor = 0;
  for (const match of text.matchAll(new RegExp(pattern, 'gmsu'))) {
    if (!match[0]) continue;
    if (match.index > cursor) parts.push(text.slice(cursor, match.index));
    parts.push(match[0]); cursor = match.index + match[0].length;
    if (parts.length > 128) return null;
  }
  if (cursor < text.length) parts.push(text.slice(cursor));
  const filter = cleanup ? new RegExp(cleanup, 'gu') : null;
  return parts.map(p => (filter ? p.replace(filter, '') : p).trim()).filter(Boolean);
})()`);

export function segmentText(text: string, config: SegmentedReply): string[] {
  let result: unknown;
  try { result = segmentScript.runInNewContext({ text, pattern: config.regex, cleanup: config.cleanupRegex },
    { timeout: 100, contextCodeGeneration: { strings: false, wasm: false } }); }
  catch { throw new QQError('segmentation', '分段正则执行失败或超过 100 毫秒，未发送；请简化正则后用新消息重试。'); }
  if (!Array.isArray(result)) throw new QQError('segmentation', '正则产生的消息段过多，请调整分段规则。');
  const parts = Array.from(result) as string[];
  if (!parts.length) throw new QQError('segmentation', '内容过滤后没有可发送的文字，请检查过滤正则。');
  return parts;
}

export function segmentInterval(text: string, config: SegmentedReply, random = Math.random): number {
  let seconds: number;
  if (config.intervalMethod === 'random') {
    const [min, max] = config.interval.split(',').map(Number);
    seconds = min + (max - min) * random();
  } else {
    // Astr-style reading delay: English words, otherwise letters/digits, plus jitter.
    const words = /^[\x00-\x7f]*$/.test(text) ? text.trim().split(/\s+/).filter(Boolean).length
      : Array.from(text.matchAll(/[\p{L}\p{N}]/gu)).length;
    seconds = Math.log(words + 1) / Math.log(config.logBase) + random() * 0.5;
  }
  return Math.min(60000, Math.round(seconds * 1000));
}

export function replyPlan(text: string, config: SegmentedReply, llmResult: boolean) {
  const eligible = config.enabled && (!config.onlyLLMResult || llmResult) && Array.from(text).length <= config.maxLength;
  const texts = (eligible ? segmentText(text, config) : [text]).flatMap(t => splitText(t));
  if (!texts.length || texts.length > 64) throw new QQError('reply_size', '回复为空或分段超过 64 条，未发送；请调整分段规则。');
  return { texts, intervals: texts.map(t => eligible ? segmentInterval(t, config) : 0) };
}
