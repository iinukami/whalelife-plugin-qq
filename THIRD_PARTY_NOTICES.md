# 第三方组件说明

本仓库的 AGPL-3.0-only 及附加条款仅适用于有权按这些条款授权的原创材料，
不改变依赖、运行时、模型、平台客户端或其他项目的许可。安装及分发时应保留
各依赖包内的 LICENSE、COPYING、NOTICE 等原文件，并履行其源码提供等义务。
本表列出直接运行依赖；传递依赖与具体版本以 package-lock.json 和包内声明为准。

| 运行依赖 | 许可声明（已安装版本） |
| --- | --- |
| `frida` | `LGPL-2.0 WITH WxWindows-exception-3.1` |
| `json5` | `MIT` |
| `parse5` | `MIT` |
| `qrcode` | `MIT` |
| `sharp` | `Apache-2.0` |
| `undici` | `MIT` |
| `ws` | `MIT` |

Sharp 的原生包还包含 libvips 等组件，涉及 LGPL-3.0-or-later 等许可；不能只用 Sharp 的 Apache-2.0 标签概括全部原生内容。以所分发平台包内的许可与来源信息为准。

## QQ 运行组件

- **NapCatQQ / NapCatQQ Framework 4.18.41**：采用上游自定义
  [Limited Redistribution License](https://github.com/NapNeko/NapCatQQ/blob/v4.18.41/LICENSE)，
  包含禁止商业用途及再分发条件。仓库只提供原创桥接源码与下载准备脚本，不包含 NapCat 二进制。
  **本插件采用 AGPL 并不使 NapCat 获得商业使用授权**；使用、打包或商业部署必须分别满足上游条件，必要时取得额外授权。
- **Frida 17.24.0**：包声明为 `LGPL-2.0 WITH WxWindows-exception-3.1`。
  接入说明及已有许可副本见 [attach/THIRD-PARTY.md](attach/THIRD-PARTY.md)
  和 [attach/FRIDA-COPYING.txt](attach/FRIDA-COPYING.txt)，上游项目为
  [frida/frida](https://github.com/frida/frida) 与 [frida/frida-node](https://github.com/frida/frida-node)。
- **QQ 客户端**属于其原权利人，安装与使用受其自身条款约束，不按本项目 AGPL 重新授权。

本说明不是对任意组件组合、发行包或商业部署的兼容性保证。不要将完整 QQ 运行栈标注为全部 AGPL 或无条件可商用。
