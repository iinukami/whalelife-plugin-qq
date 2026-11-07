# WhaleLife QQ 插件

QQ 私聊接入，复用 WhaleLife 的模型配置、人格、会话与记忆。支持白名单、文字分段、图片理解、语音转写、图库收藏和发送。QQ 空间由独立仓库提供，本仓库不包含空间插件的工具、设置页、回执存储或自主行为。

## 配置与使用

从 0.16.0 起，模型可用 `qq_acknowledge({text})` 在当前来信的耗时操作前简短接话，然后继续工具调用，最后由原渠道发送结果。入口从可信当前来信确定收件人和稳定动作 ID，无需额外查询联系人；最多 80 个字符，同一来信重复调用不会重新投递，不能换文字重试。接话沿用发送权限、白名单、分段、取消及临时资料规则，只确认消息发送，不代表业务操作完成。普通聊天直接回复，不插入固定文案或定时提示；是否接话、说什么由模型决定，插件无法保证模型每次都选择该工具。

首次安装默认关闭。进入插件设置选择人格和好友白名单，明确启用。只处理白名单好友私聊，不处理群消息或自身消息。

- Windows 桌面模式复用桌面 QQ 登录；首次使用需要本人完成登录/手机验证。不会修改 QQ 快捷方式。
- 外部模式连接已有 OneBot v11 服务，地址和令牌由用户配置。
- 对话模型沿用人格/主干选择；识图选择视觉模型，语音可用平台转写或 STT 模型。
- 当前主干上跟随 Web 当前会话；切换会话只影响下一轮，已开始的回复保留原会话。
- 图库是可选服务，缺失或故障不影响普通文字聊天。收藏/发送开关与 QQ 空间的开关独立。
- 失败或结果不确定的发送不会自动重放。重复消息及动作 ID 去重；既有用户数据升级时保留。

文字发送工具及 `qq.sendText` 保留原有 `status` 等字段，新增 `delivery`：`outcome` 为 `not_sent`（明确未发送）、`partial`（部分确认发送）、`unknown`（结果未知）或 `sent`；同时返回总段数、确认发送数、明确未发送数、未知数和未提交数。部分发送仍可能包含未知段，须一起判断。`scope=current_call` 仅表示本次调用在发送前被阻止，不推断以前同一动作的结果。发送确认不等于已读；未回复不能证明用户态度。

普通 QQ 自动回复未完整确认时，会通过宿主公开记忆接口记录最小投递事实，供后续对话区分“生成了回复”和“成功发出”；不保存额外正文或临时外部资料。回执/记忆保存失败不触发重发。旧版仅有 `failed` 的台账缺少发送阶段证据，保守标为未知；不会篡改旧记忆或自动补发旧消息。

支持临时工具的宿主上，浏览空间等临时资料后仍可调用 `qq_send_message`。QQ 只把“正文不留存”的固定摘要及指纹交给渠道去重，原文仅在当次投递使用；私有分段台账保留数量、状态和平台消息 ID，不存正文或分段计划。重复同 ID 返回既有回执，停用、重载或取消后不恢复原文、不补发剩余段，也不把摘要发到 QQ。普通发送行为不变；同一动作切换普通/临时模式会触发内容一致性检查并阻止重复发送，不应换 ID 绕过。

选择已登录桌面 QQ 时，短暂离线或不完整状态通知会暂停接入；收到完整状态并核验为原账号后恢复。检测到真正切换账号或组件初始化失败时保持阻止，避免使用另一身份操作。连接建立时及每 15 秒以只读好友列表检查原生接入是否可用，不把 WebSocket 心跳或缓存登录信息视为在线依据。协议错误仅显示固定诊断及错误码，不回显任意原始正文。

从 0.14.1 及更早版本升级后，已运行的 QQ 进程仍持有旧接入代码。在 QQ 设置中刷新账号列表并连接原账号，即可原地更新恢复检查；不退出桌面 QQ、不重复加载 NapCat、不重放失败消息。普通插件停启仍复用原连接，不反复注入。

### QQ 空间与第三方组件

[QQ 空间](https://github.com/iinukami/whalelife-plugin-qzone) 单独安装到 QQ 的 `sub/qzone/`。QQ 仅提供账号所属的传输服务，空间业务由子插件负责；单独安装 QQ 不要求安装空间。

从 0.14.4 起提供可选 `qq.qzoneReferenceApiVersion = '1.0.0'` 和 `qq.qzoneReferenceStatus({sessionId, ref, expectedKind?}, {signal})`。`sessionId` 必须取可信工具会话，`expectedKind` 为 `post` 或 `cursor`。成功返回 `{valid:true,kind,expiresAt}`（毫秒时间戳）；失败返回 `{valid:false,reason,message}`。`reason` 为 `invalid_reference`、`unreadable_reference`、`offline`、`account_changed`、`session_mismatch`、`expired` 或 `wrong_kind`。诊断不访问网络，不返回原文、图片地址、账号或凭据，不延长原有 15 分钟有效期。无法解密可能是连接重载或引用损坏，不能据此认定实际过期。

从 0.15.0 起提供可选 `qq.qzoneVideoApiVersion = '1.0.0'` 和 `qq.qzoneReadVideo({sessionId, ref, index}, {signal})`，返回 `{mime:'video/mp4'|'video/webm', base64}`。调用方从可信工具会话取 `sessionId`，使用 `qzoneBrowse` 返回的本会话 `ref` 和 `0 <= index < videoCount`（最多 8 个）。浏览结果的 `hasVideo` 保留原语义，新增 `videoCount` 仅统计引用内支持的原始视频源；封面、第三方播放器和不支持的来源不会冒充可读取视频。

QQ 只在内存中读取经账号、会话、有效期校验的空间原生视频，不接受调用方提供 URL、路径或凭据。媒体固定来自 `photovideo.photo.qq.com` 的 MP4/WebM 地址，不携带空间 Cookie、不跟随重定向；单次最多 64 MiB、60 秒，同时只允许一次视频读取。取消、停用、账号变化或下载失败均不交付、不自动重试、不落盘。旧引用缺少视频来源时仍可用于原有功能，视频需要重新浏览。QQ 不解码或理解视频、不依赖视觉或图库插件；空间消费者按需把字节交给视觉公开服务，字节和签名地址不能返回模型或写入日志。

空间插件适配：在捕获原有引用错误时，检测此可选入口并查询诊断，将固定 `message` 作为当轮临时反馈；旧父插件继续用原错误兜底。旧浏览/读图/解析入口及其错误文本保持不变，因此无需同时升级。浏览、读图没有动作 ID，其一般失败提示应要求检查连接或重新浏览，不应要求“用原动作 ID 查回执”；点赞、评论、转发仍按已有动作回执核对，诊断不是重试授权。无需改动空间插件即可解除临时上下文中的 QQ 私聊限制。

此接口只反映查询当下的引用状态，不能倒推历史失败原因；若返回有效，空间插件仍须保留原失败，不能误报成功或自动重做互动。诊断结果也是当轮临时资料，不应记录完整引用或外部正文。

QQ 源码仓库不上传 NapCat、QQ 客户端、Frida 原生二进制或个人登录资料。桌面组件按锁定版本从上游下载并校验；许可与出处见 [第三方说明](attach/THIRD-PARTY.md)。准备桌面发行包（Windows x64）额外执行：

```sh
npm run prepare:engine
npm run prepare:desktop
npm run prepare:attach
npm run build -- --desktop
```

普通 `npm run build` 生成外部 OneBot 模式可用的源码发行包，不自动下载或启动桌面组件。桌面模式未准备组件时会提示缺失。

旧版图库桥接的显式迁移脚本为 `scripts/gallery-migration.mjs`；先以不带 `--apply` 的方式预览，再按需要执行并保留备份。它不属于图库插件源码。

## 开发与构建

需要 Node.js 24.22.1 或更新版本、Git。宿主与插件采用同级独立仓库，宿主只用于公开类型与隔离测试，不复制进插件发行包。示例从同一个空父目录开始：

```sh
git clone https://github.com/iinukami/whalelife.git
cd whalelife
npm ci
cd ..
git clone https://github.com/iinukami/whalelife-plugin-gallery.git
cd whalelife-plugin-gallery
npm ci --ignore-scripts
npm run build
cd ..
git clone https://github.com/iinukami/whalelife-plugin-qq.git
cd whalelife-plugin-qq
npm ci --ignore-scripts
npm run build
npm run check
npm run prepare:attach
npm test
```

涉及 QQ 空间业务的联合回归放在 QQ 空间仓库；本项目覆盖 QQ 传输、引用诊断和图库服务接入。

将 `dist/qq/` 安装到宿主 `plugins/qq/`。首次安装后启动宿主；升级保留已有 `data/`，不要覆盖用户配置。

测试只使用模拟模型/平台和隔离目录，不使用个人账号或正式记忆。兼容测试覆盖当前宿主及既有最低宿主基线；运行测试前须保留宿主 Git 历史。

## 发布与隐私

源码仓库不包含个人配置、凭据、会话记忆、日志、数据库、第三方运行包、node_modules 或构建产物。`.gitignore` 已排除这些目录；提交前仍需检查变更。

## 许可证

本仓库原创代码采用 [GNU AGPL v3，仅限第 3 版（AGPL-3.0-only）](LICENSE)。带有相应文件声明的源码另适用 [第 7(b)、7(c) 条允许的合理署名及禁止歪曲来源条款](LICENSE-ADDITIONAL)。作者与来源见 [NOTICE.md](NOTICE.md)。

允许商业使用和收费。分发受许可覆盖的版本时，须按 AGPL 向接收者提供完整对应源码；修改版供用户通过网络交互时，须向这些用户显著提供免费获取该版本对应源码的入口。仅个人本机自用修改无需公开，也不要求向原作者提交 PR。具体权利义务以许可正文为准。

第三方依赖、模型与平台组件仍遵守各自许可，见 [第三方说明](THIRD_PARTY_NOTICES.md)；本许可不授予它们的额外使用权。独立仓库或进程隔离是工程边界，并不自动决定插件在著作权上是否属于独立作品。
