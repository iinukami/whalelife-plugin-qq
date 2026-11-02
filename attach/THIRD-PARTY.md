# 桌面进程接入组件

- Frida Node bindings 17.24.0，项目：https://github.com/frida/frida-node 。npm 包许可字段为 `LGPL-2.0 WITH WxWindows-exception-3.1`；Frida Core 许可副本见 FRIDA-COPYING.txt。上游源码及构建说明：https://github.com/frida/frida 。未修改上游二进制。
- Windows x64 N-API v8 预构建包：https://github.com/frida/frida/releases/download/17.24.0/frida-v17.24.0-napi-v8-win32-x64.tar.gz 。归档 SHA-256：`90712f462a637784cfe2713672e651f86360d45ae9f36ac99c0f9f7a913c75cb`；解压后的 build/frida_binding.node SHA-256：`ee70a01fbdca968c23602cf662ce611a3cc99ce96df922361fb02baadabe73c3`。辅助进程在导入前校验此摘要。插件构建将该文件原样复制到发行依赖目录。
- NapCatQQ Framework 4.18.41 沿用插件已有官方发行组件及 desktop-engine.lock.json / vendor/desktop-manifest.json。agent.cjs 为本插件自行实现的现有会话接入逻辑，不包含 SnowLuma 专有 DLL 或 Node addon，不依赖 SnowLuma 运行。

部署使用现有 QQ 进程，仅在主线程已有 N-API 回调中安排异步接入，随后撤销临时探测。不得从 Frida 回调内直接加载 wrapper.node：重入会导致原生 system error。17.25.0 在本机隔离环境测试触发 ntdll TLS 初始化错误，禁止自动浮动升级到该版本。
