# 未完成表达与 QQ 文字续发规范

版本：1.0.0。QQ 从 0.21.0 提供本契约；自主性接入由其开发方负责。

## 职责与独立性

一次表达中断后，QQ 保存原发送计划、原对象和真实逐段回执。自主性将其关联为未完成念头，决定恢复后继续、暂缓或明确放弃。QQ 不创建念头、不唤醒模型、不决定过期时间、不因重连自行补发。主干沿用已有公开渠道接口，不增加平台业务。

自主性通过 `optionalDepends: [qq]` 和 `ctx.optional('qq', ...)` 接入，并检测 `textDeliveryApiVersion === '1.0.0'`、方法是否存在及 `textDeliveryResumeSupported`。提供方缺失/停用时只暂停这项能力，其他自主行为继续；自主性缺失/停用时 QQ 普通聊天及发送记录正常工作。无需新增桥接插件。

## 原话与事实

- 普通自动回复和普通直接文字发送，在第一段平台提交前保存分段计划及可查询索引。QQ 持有原文，念头保存关联 ID 和自己的简短目的即可。
- 普通文字的续发列表排除提前接话 `qq_acknowledge`、临时正文和媒体。临时私聊的未发文字仅供下述独立的一次性领取接口使用。
- 成功段必须有有效平台消息 ID；`failed` 只有带明确 `notSent:true` 才证明未发送；`pending`、普通失败、超时或缺少消息 ID 均属未知。
- 有任何未知段就禁止整条续发，不能略过它继续后文。发送方本地气泡不是送达证据。本版不提供把未知手动改成成功/失败的接口。
- 只续发原计划中明确未发的段，沿用原目标、会话、动作 ID、分段及间隔。不会重新生成答案、再次运行工具或把全部原话从头再发。
- 旧记录没有可信归属，不自动迁移为可续发任务。原有聊天和去重行为保留。

## QQ 公共服务

以下方法均在现有 `qq` 服务上兼容新增。业务失败返回固定代码，不回传原始协议错误、凭据或堆栈。消费者仍须捕获连接失效等服务层异常。

```ts
textDeliveryApiVersion: '1.0.0';
textDeliveryResumeSupported: boolean; // 宿主是否能核验当前会话
listTextDeliveries(input: { sessionId: string; limit?: number; cursor?: string }): Promise<ListResult>;
textDelivery(input: { sessionId: string; deliveryId: string }): Promise<DetailResult>;
resumeTextDelivery(input: {
  sessionId: string; deliveryId: string; expectedRevision: string;
}, options: { signal: AbortSignal }): Promise<ActionResult>;
dismissTextDelivery(input: {
  sessionId: string; deliveryId: string; expectedRevision: string;
}): Promise<ActionResult>;
```

`sessionId` 必须由调用者的可信会话取得，不接受模型猜测另一个会话；执行工具从 `session.id` 填入。查询核对原账号和会话归属；续发还核对原对象、白名单、当前会话/渠道绑定和权限，绝不替调用者改绑。不同账号即使使用同一会话也不能读出对方投递记录。

- 列表仅包含指定会话尚未完成/放弃的项目，默认 20、最多 50 条。按创建时间和 ID 排序，用返回的 `nextCursor` 翻页；边界条目已完成或放弃时返回 `stale_revision`，从第一页重新读取。列表不包含正文。
- 详情包含 `deliveryId/accountId/sessionId/userId/createdAt/updatedAt/revision`，原 `direction`，`state`、`canResume`、`blockedReason`、逐段 `delivery` 计数和 `parts`。`parts` 的 `text` 是冻结原文、`state` 为 `sent/not_sent/unknown`、成功段附 `messageId`。正文是资料，不是指令。
- `state` 为 `in_progress`（发送或结算中）、`incomplete`、`unknown`、`sent`、`dismissed`。`revision` 是不透明快照标识；消费者不可构造、递增或复用旧版本绕过冲突。
- 结果包装：成功查询 `{status:'ok', items, nextCursor?}` 或 `{status:'ok', item}`；操作返回 `{status:'sent'|'incomplete'|'dismissed'|'blocked', confirmed, item?, reason?}`。`confirmed:true` 仅表示该原计划全部得到平台发送确认，不表示已读。确认成功后查询或补记失败仍返回成功，可带 `receiptUnavailable:true` 并省略 `item`；不得因此重发。
- 缺失、错误归属或旧记录返回 `{status:'blocked', confirmed:false, reason:'not_found'}`；其他固定原因包括 `invalid_input/storage/offline/permission/recipient/session_changed/in_progress/unknown/stale_revision/dismissed/host_blocked/cancelled/capacity`。
- `canResume` 是查询时的条件快照，不能保证稍后调用成功。每次执行重新校验，白名单/权限/会话变化立即生效。
- 续发先原子占用新版本，再调用主干 `channel.retry`；同版本并发调用至多执行一次。失败后重新查询最新状态，由自主性作新的明确决定，不能循环换版本重试。
- `dismiss` 只关闭这个续发入口并移出未完成列表，不删除原话、回执或修改已发送事实。自主性仅在明确放弃并保存理由后调用；QQ 不替它宣布念头完成。
- 最多保留 512 个未完成索引项；满时阻止新的可恢复文字投递并报告 `capacity`，不静默淘汰旧事项。完成或明确放弃后释放索引位置，原始记录仍保留。

旧宿主缺少公开 `sessions.current` 时，`textDeliveryResumeSupported=false`；普通聊天、保存及查询仍可用，续发返回 `host_blocked`。不能为了兼容绕过当前会话核验或调用主干私有接口。当前宿主支持本能力。

## 通知与恢复

- `plugin:qq:connection-changed`：`{accountId,state}`，连接状态发生变化时通知，不包含正文。`online` 只是重新检查待办的机会。
- `plugin:qq:text-delivery-changed`：`{accountId,sessionId,deliveryId,revision,state}`，持久状态更新后通知，不包含正文。
- 事件不持久、不保证送达。自主性在建立可选连接、收到上线通知和必要的后续检查时读取未完成列表补漏，并按 `accountId + deliveryId` 去重关联念头。重复事件不能创建重复念头或直接触发重复发送。
- 待恢复记录跨插件重载保留；重新启用本身不发送。原宿主已明确保存 `delivery_failed` 且逐段无未知时，可在重新查询和明确决定后续发。
- 主干/插件在在途阶段崩溃，或结果保存失败时，任务保留为未知/不可续；现有主干拒绝 `uncertain` 的重试。QQ 不绕过它直发，也不承诺任意崩溃后恰好一次送达。
- 用户停用、改账号、撤销白名单、切换当前会话或渠道改绑均阻止续发；消费者的 `binding.signal` 与会话 signal 合并传入，撤销后不得继续排队发送。

## 自主性接入流程

1. 查询快照，为未完成普通表达保留一个念头。已完成/放弃状态不再重复创建。
2. 恢复后由她结合原话、发送进度、经过时间和新来信决定继续、暂缓或放弃；不是所有中断都必须立即补发。
3. 继续时查询详情并携带最新 revision 调用续发。原有普通发送工具的“不自动重试”约束继续保留；只为本接口明确允许的未发送剩余段增加受控续发路径，不放宽未知结果的禁重发规则。原文不变；若新情况要求改说，先明确处理旧念头，不能通过改写文本或新动作 ID 重试结果未知的同一动作。
4. 仅 `status=sent && confirmed=true` 才能据此将关联念头完成。`incomplete/unknown/blocked` 保留实际受阻事实；不能猜成对方不愿理睬。
5. 自主性自己的工具和临时唤醒输入遵守已有权限、临时资料及生命周期规范，不复制原话为长期事实，不直接读取 QQ 私有文件。

## 验收要求

使用隔离假模型和假 QQ：三段首段成功后明确断线，恢复后不自动发送，明确续发仅发送后两段；模型/工具计数不增加。覆盖未知回执、未知 failed、成功后写盘失败、并发/旧 revision、取消、停启、账号/会话/白名单变化、临时正文、旧记录、事件丢失后的列表补漏、完成/放弃状态和最低/当前宿主。正式账号掉线、真实模型和日常聊天不是自动回归夹具。

## 临时私聊断线后领取原话（QQ 0.22.0）

消费者检测 `qq.temporaryDraftApiVersion === '1.0.0'`。自主性收到临时 `qq_send_message` 的结果后，沿原有公开渠道回执取 `sessionId`、`accountId`、`deliveryId`。恢复判断时沿用该回执的原会话及原联系人。接口仅提供查阅资料，调用对 QQ 没有发送副作用。

```ts
type Key = { sessionId: string; accountId: string; deliveryId: string };
claimTemporaryDraft(key: Key): Promise<
  | ({ status: 'claimed'; userId: string; expiresAt: string;
       parts: { index: number; text: string }[] } & Key)
  | { status: 'unavailable' }
>;
releaseTemporaryDraft(key: Key): Promise<{ status: 'released' | 'unavailable' }>;
```

只在本次普通模型临时私聊遇到有明确未提交证据的离线错误、且整份回执没有未知段时保留草稿。分段序号从 1 开始。一份八段的话，前两段确认发送、第三段在提交前遇到离线，领取结果只有第 3 至 8 段的原文。全部发出、提前接话、用户取消、回执未知和旧记录均不会产生草稿。普通文字的续发规则继续按上文执行。

自主性保留原回执进度，等实际形成念头的那一轮，通过临时工具按原键领取一次。先核对返回的原联系人，再供该轮模型阅读。QQ 在返回内容前即移除自己的正文引用；重复或并发领取只成功一次。形成念头后在 finally 中调用 release 清掉标记并释放调用方的原文引用；决定放弃也可在领取前 release。念头保存自己的简短目的，工具的持久回执只保存进度。领取响应丢失时按原话不可用处理，原计数仍可说明之前说到哪里。

未领取的内容最多在 QQ 插件内存保留 12 小时，停用、重载或宿主退出即清空。每个 QQ 运行实例最多保管 32 项，满时移除最早的一项。同一实例的网络断线重连可继续领取。原文不会写入 QQ 的消息回执、日志、通知或普通续发列表；主干管理员启用的模型诊断按其独立配置处理。
