# 视频分享公开契约

QQ 插件 0.19.0 提供 `videoShareApiVersion: '1.0.0'`、`sendVideoShare` 和 `videoShareDelivery`，用于向白名单好友分享已验证的 B 站视频。消费者通过 `optionalDepends: [qq]` 和 `ctx.optional('qq', ...)` 获取可选服务，并检查版本及方法是否存在；提供者缺失、停用或重载时停止相关功能，不读取 QQ 私有数据或直调 OneBot。

## 格式与职责

格式由 QQ 配置 `videoShareFormat: 'card' | 'miniapp'` 决定，默认 `card`，用户可在 QQ 设置的「视频分享方式」切换。每次调用进入队列时固定本次选择；消费者不能通过参数覆盖格式，也不能在失败后换格式补发。

| 格式 | 实际发送内容 | 点击行为 |
| --- | --- | --- |
| `card` | 可选封面、标题、可选描述和完整视频 URL，以一次请求发送一条普通 `image` / `text` 消息 | 点击文字 URL 打开视频网页；封面是普通图片，不是可点击跳转的 ARK 卡片 |
| `miniapp` | QQ 原生接口生成并签名的小程序卡片，校验后原样发送 | 由 QQ 小程序处理；手机播放及「打开 B 站 App」仍有兼容问题，本次没有修复 |

B 站消费者负责提供已验证视频的元数据，确认 AV、BV、封面和标题对应同一视频。QQ 仅负责参数校验、封面准备或签名生成、平台投递和回执；不访问 B 站账号，不依赖图库、视觉模型或冲浪插件，也不接受任意 ARK、JSON、磁盘路径或第三方签名服务。

## 接口

```ts
sendVideoShare(input: {
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
}, options: { signal?: AbortSignal; permission: 'full' }): Promise<VideoShareReceipt> | VideoShareReceipt;

videoShareDelivery(input: {
  userId: string; actionId: string; sessionId: string;
}): Promise<VideoShareReceipt> | VideoShareReceipt;

type VideoShareReceipt = {
  status: 'sent' | 'not_sent' | 'uncertain' | 'not_found';
  confirmed: boolean;
  duplicate: boolean;
  retryAutomatically: false;
  canRetry: false;
  platformMessageId?: string;
  ledgerSaved?: boolean;
  error?: string;
  format?: 'card' | 'miniapp';
  coverIncluded?: boolean;
};
```

输入字段与旧 `sendMiniAppShare` 相同，`jumpPath` 在图文模式下也必须提供。消费者从可信工具会话获取 `sessionId`、`personaId`、实际权限及取消信号，不让模型自报这些字段。QQ 再检查自身完整发送权限、好友白名单、非自身账号和会话存在性。接口不切换 Web 当前会话或重绑渠道；目标好友正在处理另一会话的来信时拒绝。

- `userId` 为 5–20 位非零开头的数字字符串；`actionId` 为 1–128 位 ASCII 字母、数字、点、下划线、冒号或连字符，同一外部动作必须保持稳定 ID。
- `sessionId`、可选 `personaId` 均非空且最多 200 个字符；标题非空且最多 200，描述最多 500、可为空。这些文本拒绝控制字符。
- `previewUrl` 最多 2048 个字符，仅接受 `hdslb.com` 及其子域的 HTTPS 地址，无用户信息、非默认端口或片段。**只有 `card` 允许显式传空字符串 `''` 表示无封面**；`miniapp` 仍要求封面地址。
- `webUrl` 最多 2048 个字符，必须为 `https://www.bilibili.com/video/BV…/`，无查询、片段、用户信息或非默认端口；图文中完整显示此地址，不缩短或隐藏。
- `jumpPath` 只接受 `pages/video/video?avid=<正整数>`。未知字段均拒绝，包括 `format`、重试开关、额外消息段和任意 JSON。
- `options` 只接受 `permission: 'full'` 及可选 `signal`；查询参数只接受 `userId`、`actionId`、`sessionId`。

## 图文准备与失败边界

QQ 在平台提交前下载封面，不跟随重定向，不携带 QQ 或 B 站登录凭据。只接受 JPEG、PNG、WebP 响应，下载上限取 QQ `maxMediaBytes` 与 5 MiB 中较小值，超时取 `requestTimeoutMs` 与 15 秒中较小值；同时检查响应声明大小与实际读取大小。图片解码限制 4000 万像素，按方向修正后缩放到最大 1280 × 1280、保持比例且不放大，再转为 JPEG。字节仅在本次调用内使用，通过内联图片段发送，不落入图库或调用识图模型。

未提供封面，或下载、响应检查、解码等准备失败时，保留标题、描述和完整链接，以同一次动作发送纯文字，并返回 `coverIncluded:false`。不合法的输入仍被参数校验拒绝，不能靠降级绕过地址白名单。取消或插件停止直接结束，不把取消误当封面失败继续发送。

准备完成后，封面和文字作为同一条消息提交一次，不按聊天正则再拆成多次请求。**一旦平台请求已经提交，不能因超时、断连、失败响应或缺少回执再发送文字兜底。** 小程序生成、校验失败也不会自动转为图文；小程序细节见 [原接口契约](MINIAPP-SHARING.md)。

## 回执与防重

只有明确成功且带有效非零平台消息 ID 才返回 `sent/confirmed:true`，这只证明平台接收，不证明对端显示、图片加载、点击、播放或已读。`coverIncluded:true` 表示已准备的消息包含封面，不表示收件端已显示图片。

发送前被明确阻止为 `not_sent`；平台提交后的取消、超时、断连、缺少消息 ID 或一般失败保守返回 `uncertain`。所有结果均 `retryAutomatically:false`、`canRetry:false`。消费者应保留原动作 ID 查询，不通过换 ID、改格式或删账本重试；未明确的外部结果需先核对。

新旧入口共用原小程序账本：防重键绑定 QQ 账号、会话、好友、动作 ID，内容指纹保持旧算法，包含人格和全部结构化分享字段。缺少格式字段的旧记录视为 `miniapp`；图文记录增加 `format:'card'`，准备完成后增加 `coverIncluded`。同 ID、同内容、同格式只返回既有回执；同 ID 改内容或跨格式返回 `not_sent/error:'conflict'`，不覆盖原记录、不重新发送。

`videoShareDelivery` 同时查询两种格式，读取到记录时，`format` 反映该动作原来的格式，**不受当前 QQ 设置影响**。缺少记录返回 `not_found`；参数拒绝、服务不可用或没有记录时可不包含 `format`，不能从这些响应推断曾经发送的格式。`duplicate:true` 表示回读既有记录，不代表再次投递。

执行前保存动作占位，发送前持久化 `pending`；重启后的 `pending` 按 `uncertain` 返回，禁止重发。读取错误或非空记录结构无效时返回 `uncertain/error:'storage'`。宿主 `config.read` 会把不存在文件与部分读取、解析失败统一表示为空对象，查询不能完全区分这两类情况；应保留回执文件及备份。

平台确认后的落盘失败仍返回 `sent`、平台消息 ID、`ledgerSaved:false/error:'storage'`，不得重发。账本只保留摘要、投递状态、平台 ID、固定错误码及格式标记；分享原文、封面字节和签名不写入计划、日志或记忆。成功仅记录固定事实，图文为「已通过 QQ 私聊分享一个 B 站视频链接。」；记忆保存失败不改变外部发送事实。

安全错误码沿用 `invalid_input`、`permission`、`recipient`、`session`、`binding`、`offline`、`busy`、`cancelled`、`conflict`、`storage`、`unsupported`、`invalid_card`、`uncertain`，不回显任意协议错误正文。

## 排队、取消与迁移

新旧分享共用串行准备队列，合计最多接纳 2 个调用。封面准备或签名生成不占普通消息发送队列；准备完成后按原发送间隔排队，等待正在发送的整份分段回复完成。等待期间保留轮内补充，实际发送前复核账号、会话、连接和取消状态，保存待发状态后才关闭收件入口；准备失败不封口。

调用方取消、QQ 停用、账号配置变更或重载终止在途等待，保留已确认的外部事实，不重放待发动作。查询不联网准备卡片、不发送、不恢复临时正文。旧宿主缺少轮内追加时保留原行为；服务使用已有公开配置、会话、记忆和取消契约，不要求改主干。

旧 `miniAppShareApiVersion`、`sendMiniAppShare`、`miniAppShareDelivery` 保留小程序语义，旧发送入口始终使用 `miniapp`。旧查询遇到图文记录返回 `conflict`，需要读取实际格式的消费者应使用 `videoShareDelivery`。

B 站等消费者需自行检查并迁移到新入口，才会跟随用户的格式选择。提供者缺少新服务时应明确该功能不可用，或由消费者保留其原有、明确标识的小程序功能；不得把旧入口当成已支持图文，也不得在新入口失败后偷偷改调旧入口。本次 QQ 更新不修改消费者仓库或其配置。
