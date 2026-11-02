import type { Context, Permission } from 'whalelife';

export class QQError extends Error {
  readonly code: string;
  constructor(code: string, message: string) { super(message); this.code = code; }
}
export function safeError(error: unknown): string {
  return error instanceof QQError ? error.message : '操作未完成，请检查连接或配置；敏感错误详情未输出。';
}
export function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
export function id(value: unknown): string {
  if (typeof value === 'number' && Number.isSafeInteger(value)) return String(value);
  if (typeof value === 'string' && /^-?\d{1,20}$/.test(value)) return BigInt(value).toString();
  throw new QQError('invalid_id', '消息或账号标识无效。');
}
export function account(value: unknown): string {
  const result = id(value);
  if (!/^[1-9]\d{4,19}$/.test(result)) throw new QQError('invalid_account', 'QQ 号格式无效。');
  return result;
}
export interface SegmentedReply {
  enabled: boolean; onlyLLMResult: boolean; maxLength: number; regex: string; cleanupRegex: string;
  intervalMethod: 'random' | 'log'; interval: string; logBase: number;
}
export const segmentationDefaults: SegmentedReply = {
  enabled: false, onlyLLMResult: true, maxLength: 150, regex: '.*?[。？！~…]+|.+$', cleanupRegex: '',
  intervalMethod: 'random', interval: '1.5,3.5', logBase: 2.6,
};
const legacyMediaHosts = ['qq.com', 'qpic.cn', 'gtimg.cn', 'gtimg.com'];
export interface Config {
  schemaVersion: 3; enabled: boolean; connectionMode: 'attach' | 'desktop' | 'managed' | 'external'; qqPath: string; wsUrl: string; accessToken: string;
  accountId: string; allowedUsers: string[]; personaId: string; permission: Permission;
  visionModelId: string; speechMode: 'platform' | 'model'; sttModelId: string;
  requestTimeoutMs: number; reconnectMaxMs: number; minReplyIntervalMs: number;
  maxMessageChars: number; maxMediaBytes: number; maxMediaItems: number;
  mediaHosts: string[];
  segmentedReply: SegmentedReply;
  galleryEnabled: boolean;
}
export const defaults: Config = {
  schemaVersion: 3, enabled: false, connectionMode: 'desktop', qqPath: '', wsUrl: '', accessToken: '', accountId: '', allowedUsers: [],
  personaId: '', permission: 'off', visionModelId: '', speechMode: 'platform', sttModelId: '',
  requestTimeoutMs: 30000, reconnectMaxMs: 30000, minReplyIntervalMs: 1500,
  maxMessageChars: 16000, maxMediaBytes: 20 * 1024 * 1024, maxMediaItems: 8,
  mediaHosts: [...legacyMediaHosts, 'multimedia.nt.qq.com.cn'],
  segmentedReply: segmentationDefaults,
  galleryEnabled: true,
};
function str(v: unknown, name: string, max = 500): string {
  if (typeof v !== 'string' || v.length > max || /[\u0000-\u001f]/.test(v))
    throw new QQError('config', `${name}格式无效。`);
  return v.trim();
}
export function parseSegmentation(input: unknown): SegmentedReply {
  if (input !== undefined && (!input || typeof input !== 'object' || Array.isArray(input)))
    throw new QQError('config', '分段设置格式无效。');
  const v = { ...segmentationDefaults, ...object(input) };
  if (typeof v.enabled !== 'boolean' || typeof v.onlyLLMResult !== 'boolean') throw new QQError('config', '分段开关必须为布尔值。');
  if (!Number.isInteger(v.maxLength) || v.maxLength < 1 || v.maxLength > 32000) throw new QQError('config', '分段字数阈值须为 1–32000 的整数。');
  if (!['random', 'log'].includes(v.intervalMethod)) throw new QQError('config', '分段间隔方式无效。');
  const interval = str(v.interval, '随机间隔', 100);
  if (!/^\d+(?:\.\d+)?\s*,\s*\d+(?:\.\d+)?$/.test(interval)) throw new QQError('config', '随机间隔须填写最小秒数,最大秒数，例如 1.5,3.5。');
  const [min, max] = interval.split(',').map(Number);
  if (min < 0 || max < min || max > 60) throw new QQError('config', '随机间隔须满足 0 ≤ 最小值 ≤ 最大值 ≤ 60 秒。');
  if (!Number.isFinite(v.logBase) || v.logBase <= 1 || v.logBase > 100) throw new QQError('config', '对数底数须大于 1 且不超过 100。');
  const regex = str(v.regex, '分段正则', 1000), cleanupRegex = str(v.cleanupRegex, '内容过滤正则', 1000);
  if (!regex) throw new QQError('config', '分段正则不能为空。');
  try { new RegExp(regex, 'gmsu'); } catch { throw new QQError('config', '分段正则无效，请使用 JavaScript 正则内容，不要加两侧斜杠。'); }
  try { if (cleanupRegex) new RegExp(cleanupRegex, 'gu'); } catch { throw new QQError('config', '内容过滤正则无效。'); }
  return { enabled: v.enabled, onlyLLMResult: v.onlyLLMResult, maxLength: v.maxLength, regex, cleanupRegex,
    intervalMethod: v.intervalMethod, interval: `${min},${max}`, logBase: v.logBase };
}
export function parseConfig(input: unknown): Config {
  const raw = object(input);
  if (raw.schemaVersion !== undefined && ![0, 1, 2, 3].includes(raw.schemaVersion as number))
    throw new QQError('config_version', '配置来自较新版本，请升级插件；原配置保留。');
  // v0 used url/token/selfId/allowUsers/persona; migration preserves values, never invents accounts.
  const v = { ...defaults, ...raw };
  if (raw.connectionMode === undefined && raw.schemaVersion === 2) v.connectionMode = 'managed';
  if (raw.connectionMode === undefined && (raw.schemaVersion === 0 || raw.schemaVersion === 1 || raw.wsUrl || raw.url)) v.connectionMode = 'external';
  if (raw.schemaVersion === 0) Object.assign(v, {
    wsUrl: raw.url ?? v.wsUrl, accessToken: raw.token ?? v.accessToken,
    accountId: raw.selfId ?? v.accountId, allowedUsers: raw.allowUsers ?? v.allowedUsers,
    personaId: raw.persona ?? v.personaId,
  });
  if (typeof v.enabled !== 'boolean') throw new QQError('config', '连接开关必须为布尔值。');
  const cfg = { ...defaults, enabled: v.enabled };
  if (typeof v.galleryEnabled !== 'boolean') throw new QQError('config', '图库使用开关必须为布尔值。');
  cfg.galleryEnabled = v.galleryEnabled;
  cfg.segmentedReply = parseSegmentation(raw.segmentedReply);
  if (!['attach', 'desktop', 'managed', 'external'].includes(v.connectionMode)) throw new QQError('config', '连接方式无效。');
  cfg.connectionMode = v.connectionMode;
  for (const key of ['qqPath', 'wsUrl', 'accessToken', 'accountId', 'personaId', 'visionModelId', 'sttModelId'] as const)
    cfg[key] = str(v[key], key, key === 'accessToken' ? 4096 : 1000);
  if (cfg.accountId) cfg.accountId = account(cfg.accountId);
  if (!Array.isArray(v.allowedUsers) || v.allowedUsers.length > 200) throw new QQError('config', '白名单最多 200 个 QQ 号。');
  cfg.allowedUsers = [...new Set(v.allowedUsers.map(account))];
  if (!['off', 'ask', 'full'].includes(v.permission)) throw new QQError('config', '权限只能为 off、ask 或 full。');
  cfg.permission = v.permission;
  if (!['platform', 'model'].includes(v.speechMode)) throw new QQError('config', '语音识别方式无效。');
  cfg.speechMode = v.speechMode;
  for (const [key, low, high] of [
    ['requestTimeoutMs', 1000, 120000], ['reconnectMaxMs', 1000, 120000],
    ['minReplyIntervalMs', 0, 60000], ['maxMessageChars', 100, 32000],
    ['maxMediaBytes', 1024, 25 * 1024 * 1024], ['maxMediaItems', 1, 16],
  ] as const) {
    if (!Number.isInteger(v[key]) || v[key] < low || v[key] > high) throw new QQError('config', `${key}超出范围。`);
    cfg[key] = v[key];
  }
  if (!Array.isArray(v.mediaHosts) || v.mediaHosts.length > 30) throw new QQError('config', '媒体域名配置无效。');
  cfg.mediaHosts = v.mediaHosts.map((x: unknown) => {
    const host = str(x, '媒体域名').toLowerCase();
    if (!/^[a-z0-9.-]+$/.test(host) || host.includes('..')) throw new QQError('config', '媒体域名配置无效。');
    return host;
  });
  // Repair the unchanged pre-0.5.1 default list, while preserving custom policies.
  if (cfg.mediaHosts.length === legacyMediaHosts.length && legacyMediaHosts.every(h => cfg.mediaHosts.includes(h)))
    cfg.mediaHosts.push('multimedia.nt.qq.com.cn');
  if (cfg.wsUrl) {
    let url: URL;
    try { url = new URL(cfg.wsUrl); } catch { throw new QQError('config', 'OneBot 地址无效。'); }
    if (!['ws:', 'wss:'].includes(url.protocol) || url.username || url.password || url.hash || url.search)
      throw new QQError('config', '请使用 ws/wss 地址，令牌单独填写，不在地址中包含参数。');
    if (url.protocol === 'ws:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
      throw new QQError('config', '非本机协议端必须使用 wss。');
  }
  if (cfg.enabled && (!cfg.personaId || !cfg.allowedUsers.length || (!['managed', 'attach'].includes(cfg.connectionMode) && !cfg.accountId) || (cfg.connectionMode === 'external' && !cfg.wsUrl)))
    throw new QQError('config', '连接前请填写机器人 QQ 号、人格和私聊白名单；外部模式还需要协议端地址。');
  return cfg;
}
export function validateSelections(ctx: Context, config: Config) {
  if (config.personaId && !ctx.personas.list().some(p => p.id === config.personaId))
    throw new QQError('persona', '所选人格不可用。');
  for (const [key, types] of [['visionModelId', ['chat', 'custom']], ['sttModelId', ['stt']]] as const) {
    if (!config[key]) continue;
    const model = ctx.models.connection(config[key]);
    if (!(types as readonly string[]).includes(model.type) || model.protocol !== 'openai-compatible')
      throw new QQError('model', `${key}需要 OpenAI 兼容协议及对应模型用途。`);
  }
  if (config.enabled && config.speechMode === 'model' && !config.sttModelId)
    throw new QQError('model', '请选择语音识别模型配置。');
}
export function publicConfig(config: Config) {
  const { accessToken, ...rest } = config;
  return { ...rest, hasAccessToken: !!accessToken };
}
