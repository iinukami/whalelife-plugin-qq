import type { Context, ToolDefinition, ToolSession } from 'whalelife';
import { account, object, QQError } from './config.ts';
import type { MediaAction, MediaKey, MediaPart, MediaSendOptions } from './outbound-media.ts';

export interface GallerySender {
    outboundMediaApiVersion?: string;
    sendMedia(input: MediaAction, options: MediaSendOptions): Promise<Record<string, unknown>>;
    mediaDelivery(input: MediaKey): Promise<Record<string, unknown>>;
}
export interface GalleryReader {
    describe(id: string): Promise<{ archived: boolean; purposes: string[] }>;
    readMedia(id: string, options: { signal: AbortSignal }): Promise<{ id: string; mime: string; base64: string }>;
}
export function gallerySendingTools(ctx: Context, qq: GallerySender, gallery: GalleryReader, lifetime = ctx.signal): ToolDefinition[] {
  if (qq.outboundMediaApiVersion !== '1.0.0') throw Error('QQ 图库发送需要兼容的图文发送接口。');
  const key = (args: Record<string, unknown>, session: ToolSession): MediaKey => {
    if (typeof session.id !== 'string' || !session.id) throw new QQError('session', '缺少可信会话。');
    if (typeof args.actionId !== 'string' || !args.actionId.trim() || args.actionId.length > 128 || /[\u0000-\u001f\u007f]/.test(args.actionId))
      throw new QQError('input', '需要稳定动作 ID。');
    return { sessionId: session.id, userId: account(args.userId), actionId: args.actionId };
  };
  const failed = (session: ToolSession) => ({ status: session.signal?.aborted || lifetime.aborted || ctx.signal.aborted ? 'cancelled' : 'blocked', confirmed: false,
    error: '图片不可读取或发送被拒绝。请核对图库资源、白名单、权限及发送回执；不要换动作 ID 盲目重试。', retryAutomatically: false });
  const common = { userId: { type: 'string', description: '先通过 qq_list_recipients 核实的 QQ 好友。' },
    actionId: { type: 'string', minLength: 1, maxLength: 128, description: '本次图文动作的稳定 ID；查询和明确重试保持此 ID，不换 ID 重发。' } };
  return [{
    name: 'qq_send_gallery', danger: 'ask', origin: { platform: 'QQ 私聊', action: '发送图库图文' },
    description: '将图库图片/表情和可选文字按 parts 顺序发给已授权 QQ 好友，等待逐项平台消息 ID。图片 ID 先由 gallery_search/gallery_list 得到；不可传 URL、路径、base64 或会话 ID。支持纯图片计划、多图及图前/图间/图后文字；文字沿用 QQ 分段设置。只能执行已授权或约定的发送。相同动作重复调用保持相同 actionId 和 parts；结果不确定先查回执，禁止换 ID 重发。retry=true 仅在用户明确要求且 canRetry=true 时使用，只继续未确认项目。普通聊天调用后仍须给出最终文字，不重复已经发出的图文，也不要把失败说成发送成功。',
    schema: { type: 'object', properties: { ...common, retry: { type: 'boolean', description: '默认 false；仅用户明确要求继续已知失败/取消的同一计划时设为 true。' },
      parts: { type: 'array', minItems: 1, maxItems: 16, items: { type: 'object', properties: {
        type: { type: 'string', enum: ['text', 'image'] }, text: { type: 'string', maxLength: 32000 },
        id: { type: 'string', description: '图库图片 ID，仅 image 项填写。' },
        mode: { type: 'string', enum: ['auto', 'image', 'meme'], description: '默认 auto，按图库用途选择；未标为 meme 的图片不能强行作为表情发送。' },
      }, required: ['type'], additionalProperties: false } } }, required: ['userId', 'actionId', 'parts'], additionalProperties: false },
    async run(args, session) {
      try {
        if (session.transientContext) throw new QQError('transient', '本轮含临时外部资料，不能将原文存入图文发送计划。');
        const input = object(args), target = key(input, session);
        if (session.permission !== 'full' || Object.keys(input).some(k => !['userId', 'actionId', 'parts', 'retry'].includes(k))
          || (input.retry !== undefined && typeof input.retry !== 'boolean') || !Array.isArray(input.parts) || !input.parts.length || input.parts.length > 16)
          throw new QQError('input', '权限或图文参数无效。');
        const signal = AbortSignal.any([ctx.signal, lifetime, ...(session.signal ? [session.signal] : [])]);
        const parts: MediaPart[] = []; let imageCount = 0, encodedSize = 0;
        for (const raw of input.parts) {
          signal.throwIfAborted(); const p = object(raw);
          if (p.type === 'text' && Object.keys(p).every(k => ['type', 'text'].includes(k)) && typeof p.text === 'string' && p.text.trim()) {
            parts.push({ type: 'text', text: p.text }); continue;
          }
          if (p.type !== 'image' || Object.keys(p).some(k => !['type', 'id', 'mode'].includes(k)) || typeof p.id !== 'string' || !/^[a-f0-9]{64}$/.test(p.id)
            || !['auto', 'image', 'meme'].includes(String(p.mode ?? 'auto')) || ++imageCount > 8) throw new QQError('input', '图片参数无效。');
          const description = await gallery.describe(p.id);
          if (description.archived || (p.mode === 'meme' && !description.purposes.includes('meme'))) throw new QQError('image', '图片已归档或不允许作为表情发送。');
          const media = await gallery.readMedia(p.id, { signal }); signal.throwIfAborted();
          encodedSize += media.base64.length;
          if (encodedSize > Math.ceil(25 * 1024 * 1024 / 3) * 4) throw new QQError('size', '单次图文原图总量超过 25 MiB。');
          parts.push({ type: 'image', ...media, asMeme: p.mode === 'meme' || (p.mode !== 'image' && description.purposes.includes('meme')) });
        }
        if (!imageCount) throw new QQError('input', '至少需要一张图库图片。');
        return await qq.sendMedia({ ...target, personaId: session.personaId, parts }, { signal, retry: input.retry === true });
      } catch { return failed(session); }
    },
  }, {
    name: 'qq_gallery_delivery', danger: 'safe', origin: { platform: 'QQ 私聊', action: '查询图文发送回执' },
    description: '查询本会话内某次 QQ 图文动作的逐项发送回执；不发消息、不读取原图、不重试。只有 sent 且 confirmed=true 表示全部有真实平台消息 ID。uncertain 不允许自动或手动盲重发；部分 sent 项也不能重复发送。',
    schema: { type: 'object', properties: common, required: ['userId', 'actionId'], additionalProperties: false },
    async run(args, session) {
      try {
        lifetime.throwIfAborted();
        const input = object(args);
        if (Object.keys(input).some(k => !['userId', 'actionId'].includes(k))) throw new QQError('input', '查询参数无效。');
        return await qq.mediaDelivery(key(input, session));
      } catch { return failed(session); }
    },
  }];
}

/** Compatibility entry for hosts without optional services. */
export function registerGallerySending(ctx: Context) {
  for (const tool of gallerySendingTools(ctx, ctx.get<GallerySender>('qq'), ctx.get<GalleryReader>('gallery')))
    ctx.tools.register(tool);
}
