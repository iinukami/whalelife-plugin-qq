# 小程序分享公开契约

QQ 插件 0.18.0 向可信插件提供 `miniAppShareApiVersion: '1.0.0'`。仅支持 B 站视频预设，不注册面向模型的任意 JSON 发送工具。消费者应通过 `optionalDepends: [qq]` 与 `ctx.optional('qq', ...)` 取得服务，在提供者缺失、停用或重载时停止本功能；不得读取 QQ 私有数据或直调 OneBot。

```ts
sendMiniAppShare(input: {
  userId: string;
  actionId: string;
  sessionId: string;
  personaId?: string;
  preset: 'bili';
  title: string;
  description: string;
  previewUrl: string;
  jumpPath: string;
  webUrl: string;
}, options: { signal?: AbortSignal; permission: 'full' }): Promise<Receipt> | Receipt;

miniAppShareDelivery(input: {
  userId: string; actionId: string; sessionId: string;
}): Promise<Receipt> | Receipt;

type Receipt = {
  status: 'sent' | 'not_sent' | 'uncertain' | 'not_found';
  confirmed: boolean;
  duplicate: boolean;
  retryAutomatically: false;
  canRetry: false;
  platformMessageId?: string;
  ledgerSaved?: boolean;
  error?: string;
};
```

消费者必须从可信工具会话取得 `sessionId`、`personaId`、实际权限和取消信号，不能从模型参数接受这些字段。QQ 再检查自身完整发送权限、好友白名单、非自身账号及会话是否存在。接口不切换 Web 当前会话、不重绑渠道；目标好友正在处理另一会话的入站消息时拒绝，本会话正式发送前关闭继续收件入口。旧宿主没有轮内追加时保持原行为。

`userId` 必须是 5–20 位非零开头的数字字符串。`actionId` 为 1–128 位 ASCII 字母、数字、点、下划线、冒号或连字符；消费者须为同一外部动作保持稳定 ID。`sessionId` 不超过 200 个字符。标题非空且最多 200，描述最多 500，可为空；二者均拒绝控制字符。未知字段（包括任意 ARK、JSON、路径、重试开关）拒绝。

封面只接受 `hdslb.com` 及其子域的 HTTPS 地址，无用户信息、非默认端口或片段。`webUrl` 必须为 `https://www.bilibili.com/video/BV…/`，无查询或片段。`jumpPath` 只接受 `pages/video/video?avid=<正整数>`；不接受尚未证实的小程序 BV 路径。QQ 不解析 B 站数据，消费者负责确认 AV 与 BV 来自同一个已验证视频。

QQ 将结构化字段映射为 NapCat `get_mini_app_ark({type:'bili', title, desc:description, picUrl:previewUrl, jumpUrl:jumpPath, webUrl})`。该能力通过 QQ 原生 `LightAppSvc.mini_app_share.AdaptShareInfo` 生成签名，要求协议端支持对应动作及 Packet 能力；本仓锁定的 NapCat 4.18.41 提供此接口。缺失时返回 `not_sent`，不通过第三方网站补签名。

仅接受协议成功响应中的完整 ARK 对象，检查 `app === 'com.tencent.miniapp_01'`、非空 `config.token`、`meta.detail_1.appid === '1109937557'` 及 `meta.detail_1.url === jumpPath`，并限制序列化大小为 64 KiB。随后原样序列化整个对象，经 `send_private_msg` 的 `json` 消息段发送；不修改签名字段、标题、时间或额外元数据。普通 `share` 消息段不在此契约内。

只有明确成功且包含有效非零平台消息 ID 才返回 `sent/confirmed:true`。该回执不证明对端卡片渲染、点击成功或已读。真实跳转及对端显示仍需单独验收；合成协议测试只能证明本地校验、参数映射、发送及防重行为。若协议返回的跳转与请求不完全相同，安全拒绝，不能猜测或改写签名。

防重键绑定 QQ 账号、会话、好友和动作 ID，内容指纹绑定全部结构化分享字段及人格。持久账本不含这些原始字段，仅保留版本、键摘要、指纹、状态、平台消息 ID 和固定错误码。生成签名前先保存动作占位，投递前再持久化 `pending`；公开存储接口返回的非空记录结构无效或读取抛错时拒绝继续。重启后的 `pending` 视为 `uncertain`，禁止再次发送；同 ID 改内容为 `conflict`。`duplicate:true` 是既有回执，绝不代表又发送一次。

查询时读取或结构错误返回 `uncertain/error:'storage'`，不能把查不到结果说成从未发送。参数、权限、会话等查询错误只表示本次调用被拒绝，不推断既往动作。宿主现行 `config.read` 对不存在文件与部分读取/JSON 解析失败统一返回空对象；插件不能仅凭此公开接口区分它们。用户应保留回执文件和备份，不通过删除或修改账本来重试旧动作。

生成签名失败或明确在发送前被拒绝为 `not_sent`；实际投递后的取消、超时、断连、缺少消息 ID 或一般协议失败保守为 `uncertain`。不自动重试、换 ID 补发或退回文字链接。消费者应查询原动作回执，若仍不确定，让用户在 QQ 核对后决定另一个明确动作。

确认发送后的保存失败仍返回 `sent`、平台消息 ID 和 `ledgerSaved:false/error:'storage'`；禁止据此重发。成功记忆仅为“已通过 QQ 私聊发送一张 B 站视频小程序卡片。”，不含标题、封面、地址、签名或目标账号。失败记忆不自动补写，生成或发送原文不会持久化。所有协议错误仅输出以下固定安全码：`invalid_input`、`permission`、`recipient`、`session`、`binding`、`offline`、`busy`、`cancelled`、`conflict`、`storage`、`unsupported`、`invalid_card`、`uncertain`。

卡片生成在独立的串行队列中进行，同时最多接纳 2 个卡片调用；不会因生成卡片较慢而阻塞普通文字、图片发送。签名卡片通过校验后才进入 QQ 原有发送队列，沿用发送间隔并等待正在发送的整份分段回复完成，不插入它的段落中间。生成、校验及等待发送期间仍可接收本轮补充，仅在实际发送前完成会话和状态复核、持久化待发记录，再关闭本轮收件入口。卡片生成或校验失败不会关闭收件入口。

调用方取消、插件关闭、账号配置变更或重载会终止生成及发送队列中的在途等待，已确认的外部事实保留。查询只返回回执，不重新生成签名、发送消息或恢复临时正文。QQ 不依赖 B 站或冲浪插件；未安装、停用这些消费者时，本服务处于未调用状态，不产生后台请求，不影响 QQ 独立运行。

该新增服务依赖现有公开配置、会话、记忆与取消契约，不要求修改宿主。兼容测试覆盖当前宿主和最低基线 `213b52b`；消费者使用可选服务订阅时应另行检查其宿主是否支持 `ctx.optional`。现有文字、图库、空间及旧账本保持原语义。
