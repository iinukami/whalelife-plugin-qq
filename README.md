# WhaleLife QQ 插件

QQ 私聊接入，复用 WhaleLife 的模型配置、人格、会话与记忆。支持白名单、文字分段、图片理解、语音转写、图库收藏和发送。QQ 空间由独立仓库提供，本仓库不包含空间插件的工具、设置页、回执存储或自主行为。

## 配置与使用

首次安装默认关闭。进入插件设置选择人格和好友白名单，明确启用。只处理白名单好友私聊，不处理群消息或自身消息。

- Windows 桌面模式复用桌面 QQ 登录；首次使用需要本人完成登录/手机验证。不会修改 QQ 快捷方式。
- 外部模式连接已有 OneBot v11 服务，地址和令牌由用户配置。
- 对话模型沿用人格/主干选择；识图选择视觉模型，语音可用平台转写或 STT 模型。
- 当前主干上跟随 Web 当前会话；切换会话只影响下一轮，已开始的回复保留原会话。
- 图库是可选服务，缺失或故障不影响普通文字聊天。收藏/发送开关与 QQ 空间的开关独立。
- 失败或结果不确定的发送不会自动重放。重复消息及动作 ID 去重；既有用户数据升级时保留。

### QQ 空间与第三方组件

[QQ 空间](https://github.com/iinukami/whalelife-plugin-qzone) 单独安装到 QQ 的 `sub/qzone/`。QQ 仅提供账号所属的传输服务，空间业务由子插件负责；单独安装 QQ 不要求安装空间。

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

涉及 QQ 空间的联合回归放在 QQ 空间仓库；本项目仅保留 QQ 和图库服务接入测试。

将 `dist/qq/` 安装到宿主 `plugins/qq/`。首次安装后启动宿主；升级保留已有 `data/`，不要覆盖用户配置。

测试只使用模拟模型/平台和隔离目录，不使用个人账号或正式记忆。兼容测试覆盖当前宿主及既有最低宿主基线；运行测试前须保留宿主 Git 历史。

## 发布与隐私

源码仓库不包含个人配置、凭据、会话记忆、日志、数据库、第三方运行包、node_modules 或构建产物。`.gitignore` 已排除这些目录；提交前仍需检查变更。

## 许可证

本仓库原创代码采用 [GNU AGPL v3，仅限第 3 版（AGPL-3.0-only）](LICENSE)。带有相应文件声明的源码另适用 [第 7(b)、7(c) 条允许的合理署名及禁止歪曲来源条款](LICENSE-ADDITIONAL)。作者与来源见 [NOTICE.md](NOTICE.md)。

允许商业使用和收费。分发受许可覆盖的版本时，须按 AGPL 向接收者提供完整对应源码；修改版供用户通过网络交互时，须向这些用户显著提供免费获取该版本对应源码的入口。仅个人本机自用修改无需公开，也不要求向原作者提交 PR。具体权利义务以许可正文为准。

第三方依赖、模型与平台组件仍遵守各自许可，见 [第三方说明](THIRD_PARTY_NOTICES.md)；本许可不授予它们的额外使用权。独立仓库或进程隔离是工程边界，并不自动决定插件在著作权上是否属于独立作品。
