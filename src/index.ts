/*! Copyright (c) 2026 iinukami and contributors.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */
import { randomUUID } from 'node:crypto';
import type { Context, PluginHandler } from 'whalelife';
import { defaults, parseConfig, parseSegmentation, publicConfig, validateSelections, object, QQError, safeError, type Config } from './config.ts';
import { QQRuntime } from './runtime.ts';
import { page, script } from './page.ts';
import { ManagedEngine } from './managed-engine.ts';
import { DesktopBridge } from './desktop-bridge.ts';
import { DesktopAttach } from './desktop-attach.ts';
import { replyPlan } from './segmentation.ts';
import { registerQQTools } from './tools.ts';
import { InboundMedia } from './inbound-media.ts';
import { GroupSubscription, type GroupReceiver, type GroupSubscriptionOptions } from './group-subscription.ts';
import type { GroupOptions } from './group-connection.ts';
import type { GroupMediaInput, GroupTextInput } from './group-outbound.ts';
import type { MediaAction, MediaKey, MediaSendOptions } from './outbound-media.ts';
import { miniAppFailure, type MiniAppShare, type MiniAppKey, type MiniAppOptions } from './outbound-miniapp.ts';
import type { PublishPayload, BrowseInput, Interaction, ReferenceInput } from './space/types.ts';
import { galleryReceiver, apply as legacyGallery, type GalleryService } from './gallery-bridge.ts';
import { gallerySendingTools } from './gallery-send.ts';

export async function apply(ctx: Context) {
  let config: Config = { ...defaults }, runtime: QQRuntime | undefined, error = '', revision = randomUUID();
  let changes: Promise<unknown> = Promise.resolve();
  let engine: ManagedEngine | undefined;
  let desktop: DesktopBridge | undefined;
  const attach = new DesktopAttach();
  const inboundMedia = new InboundMedia();
  const groupSubscription = new GroupSubscription();
  ctx.effect(() => () => groupSubscription.dispose());
  const builtinGallery = typeof ctx.optional === 'function';
  let unsubscribeGallery: (() => void) | undefined;
  ctx.effect(() => () => unsubscribeGallery?.());
  ctx.effect(() => () => inboundMedia.dispose());
  const stop = async () => {
    const old = runtime, oldEngine = engine; runtime = undefined; engine = undefined; desktop = undefined;
    await Promise.all([old?.stop(), oldEngine?.stop()]);
  };
  // Register cleanup before reading config or constructing any network resource.
  ctx.effect(() => async () => { await stop(); await changes.catch(() => {}); });
  const start = async () => {
    ctx.signal.throwIfAborted();
    if (!config.enabled) return;
    if (config.connectionMode === 'managed') {
      const current = new ManagedEngine(config, ctx.signal, effective => {
        if (engine !== current || ctx.signal.aborted) return;
        runtime = new QQRuntime(ctx, effective, inboundMedia, groupSubscription); runtime.start();
      }, () => { if (engine !== current) return; const old = runtime; runtime = undefined; return old?.stop(); });
      engine = current; current.start();
    } else {
      if (config.connectionMode === 'attach') {
        const effective = await attach.resume(config, ctx.signal);
        if (!effective) { error = '请选择当前已登录的桌面 QQ。'; return; }
        ctx.signal.throwIfAborted(); runtime = new QQRuntime(ctx, effective, inboundMedia, groupSubscription); runtime.start(); return;
      }
      if (config.connectionMode === 'desktop') desktop = new DesktopBridge(config, ctx.signal);
      const effective = desktop ? await desktop.prepare() : config;
      ctx.signal.throwIfAborted(); runtime = new QQRuntime(ctx, effective, inboundMedia, groupSubscription); runtime.start();
    }
  };
  const status = () => ({ ...(runtime?.status() ?? { state: engine?.status.state ?? (config.enabled ? 'unconfigured' : 'disabled'), error: engine?.status.error || error, queued: 0, recent: [] }),
    mediaBridge: { active: inboundMedia.active(), mode: builtinGallery ? 'builtin' : 'legacy', enabled: config.galleryEnabled }, ...(engine ? { engine: { ...engine.status } } : {}) });
  try {
    const raw = await ctx.config.read(); config = parseConfig(raw); validateSelections(ctx, config);
    if (raw.schemaVersion === 0 || raw.schemaVersion === 1 || raw.schemaVersion === 2) {
      await ctx.config.save(`config-v${raw.schemaVersion}-backup.json`, raw); await ctx.config.save('config.json', config);
    } else if (Array.isArray(raw.mediaHosts) && raw.mediaHosts.length === 4 && config.mediaHosts.length === 5) {
      await ctx.config.save('config-before-nt-media.json', raw); await ctx.config.save('config.json', config);
    } else if (Object.hasOwn(raw, 'persona') || Object.hasOwn(raw, 'personaId')) {
      const { persona, personaId, ...settings } = raw;
      await ctx.config.save('config.json', settings);
    }
    await start();
  } catch (e) { error = safeError(e); ctx.logger.warn('QQ 插件等待有效配置', { error }); }
  const groupAccount = () => runtime?.config.accountId || config.accountId || '';
  const activeGroups = () => {
    if (!runtime || ctx.signal.aborted) throw new QQError('offline', 'QQ 群服务尚未连接。', true);
    return runtime.groups;
  };
  const qqService = {
    groupApiVersion: '1.0.0',
    groupStatus: () => ({ online: runtime?.state.state === 'online', accountId: groupAccount() || null, scope: groupSubscription.scope(groupAccount()) }),
    registerGroupReceiver: (receive: GroupReceiver, options: GroupSubscriptionOptions) => groupSubscription.register(groupAccount(), receive, options),
    listGroups: (options?: GroupOptions) => activeGroups().listGroups(options),
    groupInfo: (groupId: string, options?: GroupOptions) => activeGroups().groupInfo(groupId, options),
    listGroupMembers: (groupId: string, options?: GroupOptions) => activeGroups().listGroupMembers(groupId, options),
    sendGroupText: (input: GroupTextInput, options?: GroupOptions) => activeGroups().sendText(input, options),
    sendGroupMedia: (input: GroupMediaInput, options?: GroupOptions) => runtime && !ctx.signal.aborted ? runtime.groups.sendMedia(input, options) :
      Promise.resolve({ status: 'not_submitted', confirmed: false, retryAutomatically: false, error: 'QQ 群服务尚未连接。' }),
    apiVersion: '1.0.0', status,
    temporaryDraftApiVersion: '1.0.0',
    claimTemporaryDraft: (key: import('./temporary-drafts.ts').DraftKey) => runtime?.claimTemporaryDraft(key) ?? { status: 'unavailable' },
    releaseTemporaryDraft: (key: import('./temporary-drafts.ts').DraftKey) => runtime?.releaseTemporaryDraft(key) ?? { status: 'unavailable' },
    textDeliveryApiVersion: '1.0.0',
    textDeliveryResumeSupported: typeof ctx.sessions.current === 'function',
    listTextDeliveries: (input: import('./text-continuation.ts').DeliveryList) => runtime
      ? runtime.listTextDeliveries(input) : { status: 'blocked', confirmed: false, reason: 'offline' },
    textDelivery: (input: import('./text-continuation.ts').DeliveryKey) => runtime
      ? runtime.textDelivery(input) : { status: 'blocked', confirmed: false, reason: 'offline' },
    resumeTextDelivery: (input: import('./text-continuation.ts').DeliveryDecision, options: { signal: AbortSignal }) => runtime
      ? runtime.resumeTextDelivery(input, options) : { status: 'blocked', confirmed: false, reason: 'offline' },
    dismissTextDelivery: (input: import('./text-continuation.ts').DeliveryDecision) => runtime
      ? runtime.dismissTextDelivery(input) : { status: 'blocked', confirmed: false, reason: 'offline' },
    qzoneApiVersion: '1.0.0',
    qzoneSocialApiVersion: '1.0.0',
    qzoneReferenceApiVersion: '1.0.0',
    qzoneVideoApiVersion: '1.0.0',
    qzoneReadVideo: (input: { sessionId: string; ref: string; index: number }, options: { signal: AbortSignal }) => {
      ctx.signal.throwIfAborted();
      if (!runtime) throw new QQError('offline', 'QQ 连接尚未开启。');
      return runtime.spaceWeb.readVideo(input, options);
    },
    qzoneReferenceStatus: (input: ReferenceInput, options: { signal: AbortSignal }) => {
      ctx.signal.throwIfAborted(); options.signal.throwIfAborted();
      if (!runtime) return { valid: false, reason: 'offline', message: 'QQ 不在线，请恢复原账号连接后再检查引用。' };
      return runtime.spaceWeb.referenceStatus(input, options);
    },
    qzoneStatus: () => ({ accountId: runtime?.config.accountId || config.accountId || null, online: runtime?.state.state === 'online' }),
    qzonePublish: (input: PublishPayload, options: { signal: AbortSignal }) => {
      ctx.signal.throwIfAborted();
      if (!runtime) return { status: 'not_submitted', error: 'QQ 连接尚未开启。' };
      return runtime.qzonePublish(input, options);
    },
    qzoneBrowse: (input: BrowseInput, options: { signal: AbortSignal }) => {
      if (!runtime) throw new QQError('offline', 'QQ 连接尚未开启。'); return runtime.spaceWeb.browse(input, options);
    },
    qzoneResolve: (input: { sessionId: string; ref: string }, options: { signal: AbortSignal }) => {
      if (!runtime) throw new QQError('offline', 'QQ 连接尚未开启。'); return runtime.spaceWeb.resolve(input, options);
    },
    qzoneInteract: (input: { sessionId: string; ref: string; action: Interaction }, options: { signal: AbortSignal }) => {
      if (!runtime) return { status: 'not_submitted' }; return runtime.spaceWeb.interact(input, options);
    },
    qzoneReadImage: (input: { sessionId: string; ref: string; index: number }, options: { signal: AbortSignal }) => {
      if (!runtime) throw new QQError('offline', 'QQ 连接尚未开启。'); return runtime.spaceWeb.readImage(input, options);
    },
    qzoneDescribeImage: (input: { sessionId: string; ref: string; index: number }, options: { signal: AbortSignal }) => {
      if (!runtime) throw new QQError('offline', 'QQ 连接尚未开启。'); return runtime.qzoneDescribeImage(input, options);
    },
    mediaApiVersion: '1.0.0',
    registerMediaReceiver: inboundMedia.register.bind(inboundMedia),
    outboundMediaApiVersion: '1.0.0',
    outboundVoiceApiVersion: '1.0.0',
    sendMedia: (input: MediaAction, options?: MediaSendOptions) => {
      ctx.signal.throwIfAborted();
      if (!runtime) throw new QQError('offline', 'QQ 连接尚未开启。');
      return runtime.sendMedia(input, options);
    },
    mediaDelivery: (input: MediaKey) => {
      ctx.signal.throwIfAborted();
      if (!runtime) throw new QQError('offline', 'QQ 连接尚未开启。');
      return runtime.mediaDelivery(input);
    },
    videoShareApiVersion: '1.0.0',
    sendVideoShare: (input: MiniAppShare, options: MiniAppOptions) => {
      if (ctx.signal.aborted) return miniAppFailure('cancelled');
      if (!runtime) return miniAppFailure('offline');
      return runtime.sendVideoShare(input, options);
    },
    videoShareDelivery: (input: MiniAppKey) => {
      if (ctx.signal.aborted) return miniAppFailure('cancelled');
      if (!runtime) return miniAppFailure('offline');
      return runtime.videoShareDelivery(input);
    },
    miniAppShareApiVersion: '1.0.0',
    sendMiniAppShare: (input: MiniAppShare, options: MiniAppOptions) => {
      if (ctx.signal.aborted) return miniAppFailure('cancelled');
      if (!runtime) return miniAppFailure('offline');
      return runtime.sendMiniAppShare(input, options);
    },
    miniAppShareDelivery: (input: MiniAppKey) => {
      if (ctx.signal.aborted) return miniAppFailure('cancelled');
      if (!runtime) return miniAppFailure('offline');
      return runtime.miniAppShareDelivery(input);
    },
    getSelfId: () => runtime?.config.accountId || config.accountId || null,
    sendText: async (input: { userId: string; messageId: string; text: string }) => {
      ctx.signal.throwIfAborted();
      if (!runtime) throw new QQError('offline', 'QQ 连接尚未开启。');
      return runtime.sendText(input);
    },
  };
  ctx.provide('qq', qqService);
  const syncGallery = () => {
    unsubscribeGallery?.(); unsubscribeGallery = undefined;
    if (!builtinGallery || !config.galleryEnabled) return;
    unsubscribeGallery = ctx.optional<GalleryService>('gallery', binding => {
      if (!binding) return;
      const disposers: (() => void)[] = [];
      try {
        const tools = gallerySendingTools(ctx, qqService, binding.service, binding.signal);
        disposers.push(binding.effect(() => inboundMedia.register(galleryReceiver(binding.service, binding.signal), { signal: binding.signal })));
        for (const tool of tools) disposers.push(binding.effect(() => ctx.tools.register(tool)));
      } catch {
        for (const dispose of disposers.reverse()) dispose();
        ctx.logger.warn('QQ 图库使用暂不可用，聊天和识图继续运行。');
      }
    });
  };
  if (builtinGallery) syncGallery();
  else await ctx.plugin({ id: 'gallery', apply: legacyGallery });
  registerQQTools(ctx, () => runtime);
  const wrap = (handler: PluginHandler): PluginHandler => async (req, res, options) => {
    try { await handler(req, res, options); }
    catch (e) {
      if (res.destroyed || res.writableEnded || options.signal.aborted) return;
      res.statusCode = e instanceof QQError && e.code === 'conflict' ? 409 : 400;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(JSON.stringify({ error: safeError(e) }));
    }
  };
  ctx.web.page('/plugins/qq/settings', (_req, res) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'self'");
    res.end(page);
  }, { title: 'QQ', settings: true, navigation: true });
  ctx.web.page('/plugins/qq/settings.js', (_req, res) => { res.setHeader('Content-Type', 'text/javascript; charset=utf-8'); res.end(script); });
  ctx.web.page('/plugins/qq/status', wrap((req, res) => {
    if (req.method !== 'GET') throw new QQError('method', '仅支持 GET。');
    res.setHeader('Content-Type', 'application/json; charset=utf-8'); res.setHeader('Cache-Control', 'no-store'); res.end(JSON.stringify(status()));
  }));
  const configHandler: PluginHandler = wrap(async (req, res, { signal }) => {
    if (req.method === 'POST') {
      let body = ''; for await (const chunk of req) { body += chunk; if (Buffer.byteLength(body) > 20000) throw new QQError('body', '配置请求过大。'); }
      let input: Record<string, unknown>;
      try { input = object(JSON.parse(body)); } catch { throw new QQError('json', '请求必须为有效 JSON。'); }
      const save = changes.then(async () => {
        signal.throwIfAborted(); ctx.signal.throwIfAborted();
        if (input.revision !== revision) throw new QQError('conflict', '配置已被其他页面更新，请刷新后重试。');
        const incoming = object(input.config);
        const token = typeof incoming.accessToken === 'string' ? incoming.accessToken : '';
        if (incoming.wsUrl !== config.wsUrl && config.accessToken && !token && input.clearToken !== true)
          throw new QQError('token', '修改协议端地址时，请重新输入或明确清除令牌。');
        const next = parseConfig({ ...incoming, accessToken: input.clearToken === true ? '' : token || config.accessToken });
        validateSelections(ctx, next);
        const galleryChanged = config.galleryEnabled !== next.galleryEnabled;
        if (galleryChanged && !builtinGallery) throw new QQError('config', '旧宿主请在插件管理中启停图库接入。');
        const galleryOnly = galleryChanged && JSON.stringify({ ...next, galleryEnabled: config.galleryEnabled }) === JSON.stringify(config);
        if (!galleryOnly) await stop();
        signal.throwIfAborted(); ctx.signal.throwIfAborted();
        await ctx.config.save('config.json', next);
        config = next; error = ''; revision = randomUUID();
        if (galleryChanged) syncGallery();
        if (!galleryOnly) await start();
      });
      changes = save.catch(() => {}); await save;
    } else if (req.method !== 'GET') throw new QQError('method', '仅支持 GET 和 POST。');
    res.setHeader('Content-Type', 'application/json; charset=utf-8'); res.setHeader('Cache-Control', 'no-store');
    res.end(JSON.stringify({ config: publicConfig(config), revision, status: status(), models: ctx.models.list() }));
  });
  ctx.web.page('/plugins/qq/config', configHandler);
  ctx.web.api('/plugins/qq/config', configHandler);
  ctx.web.api('/plugins/qq/segmentation/preview', wrap(async (req, res, { signal }) => {
    let body = ''; for await (const chunk of req) { body += chunk; if (Buffer.byteLength(body) > 140000) throw new QQError('body', '预览内容过长。'); }
    let input: Record<string, unknown>;
    try { input = object(JSON.parse(body)); } catch { throw new QQError('json', '预览请求格式无效。'); }
    if (typeof input.text !== 'string' || Array.from(input.text).length > 32000) throw new QQError('preview', '预览文字最多 32000 字。');
    signal.throwIfAborted();
    const result = replyPlan(input.text, parseSegmentation(input.config), true);
    signal.throwIfAborted(); res.setHeader('Content-Type', 'application/json'); res.setHeader('Cache-Control', 'no-store');
    res.end(JSON.stringify(result));
  }));
  ctx.web.api('/plugins/qq/desktop/open', wrap(async (req, res, { signal }) => {
    if (req.method !== 'POST') throw new QQError('method', '仅支持 POST。');
    const opening = changes.then(async () => {
      signal.throwIfAborted(); ctx.signal.throwIfAborted();
      if (!desktop) throw new QQError('offline', '请先选择桌面共用登录，开启连接并保存设置。');
      if (runtime?.status().state === 'online') return { opened: false, online: true };
      return desktop.open(signal);
    });
    changes = opening.catch(() => {});
    const result = await opening; res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(result));
  }));
  ctx.web.api('/plugins/qq/desktop/accounts', wrap(async (req, res, { signal }) => {
    if (req.method !== 'POST') throw new QQError('method', '仅支持 POST。');
    const task = changes.then(() => attach.list(AbortSignal.any([signal, ctx.signal])));
    changes = task.catch(() => {});
    const accounts = await task; res.setHeader('Content-Type', 'application/json'); res.setHeader('Cache-Control', 'no-store'); res.end(JSON.stringify({ accounts }));
  }));
  ctx.web.api('/plugins/qq/desktop/connect', wrap(async (req, res, { signal }) => {
    if (req.method !== 'POST') throw new QQError('method', '仅支持 POST。');
    let body = ''; for await (const chunk of req) { body += chunk; if (Buffer.byteLength(body) > 2048) throw new QQError('body', '请求过大。'); }
    const input = object(JSON.parse(body));
    const task = changes.then(async () => {
      if (input.revision !== revision) throw new QQError('conflict', '设置已变化，请刷新后重试。');
      if (!config.enabled || config.connectionMode !== 'attach') throw new QQError('config', '请先选择“连接已登录的 QQ”，开启连接并保存设置。');
      if (typeof input.id !== 'string') throw new QQError('config', '请选择一个在线账号。');
      const effective = await attach.connect(input.id, config, AbortSignal.any([signal, ctx.signal]));
      await stop(); signal.throwIfAborted(); ctx.signal.throwIfAborted();
      const next = { ...config, accountId: effective.accountId };
      await ctx.config.save('config.json', next); config = next; revision = randomUUID(); error = '';
      runtime = new QQRuntime(ctx, effective, inboundMedia, groupSubscription); runtime.start();
    });
    changes = task.catch(() => {}); await task;
    res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ accountId: config.accountId, status: status() }));
  }));
  ctx.web.api('/plugins/qq/refresh-qr', wrap(async (_req, res) => {
    if (!engine) throw new QQError('offline', '请先开启托管连接。');
    await engine.refreshQR(); res.setHeader('Content-Type', 'application/json'); res.end('{"ok":true}');
  }));
}
