# Iris 知识草稿审批与发布设计

> 设计日期：2026-07-19  
> 状态：待书面审阅  
> 宪法依据：`2026-06-30-iris-architecture-whitepaper.md`  
> 前置设计：`2026-07-18-iris-knowledge-draft-facts-design.md`  
> 需求基线：IRIS-CORE-007、IRIS-CORE-008、IRIS-CORE-013  
> 交付阶段：Phase 5B

## 1. 目标

Phase 5B 完成知识草稿从“可审查事实”到“经人确认后写入飞书知识库”的完整闭环：

```text
知识草稿
-> 在来源群发送完整且可追溯的交互卡片
-> 群成员确认、要求修改或拒绝
-> 按风险等级完成负责人或管理员审批
-> 通用审批与行动层生成获批行动
-> 发布执行器再次核验权限并写入飞书知识库
-> 记录飞书节点、文档版本和执行证据
-> 将成功、失败或待对账结果报告回来源群
```

本设计实现白皮书第 3.5 节的 `Approval & Action Layer`，并补齐第 7.4 节的知识发布流程。飞书卡片是协作入口，不是授权事实来源；模型、卡片回传参数和知识草稿本身都不能直接触发外部写入。

## 2. 已选架构

采用“飞书卡片 -> 通用审批与行动层 -> 专用发布执行器”的分层方案。

### 2.1 选择理由

- 白皮书明确要求所有高影响行动都经过同一个审批与行动边界。
- 知识库发布只是第一个高影响行动，后续创建正式任务、跨群发送和调用外部系统可以复用相同的授权、执行、审计和恢复机制。
- 卡片回调和飞书发布具有不同的失败语义。分层后，用户点击成功不等于外部写入成功。
- 审批事实持久化在 Postgres，服务重启、重复回调和飞书重试不会丢失或重复执行用户意图。
- 外部写入前由 TypeScript Core 重新读取可信事实并执行实时权限检查，避免把不可信内容固化到公司知识库。

### 2.2 未选择的方案

1. **卡片确认后直接发布。** 实现较短，但把 UI 回调、授权决策和外部副作用绑在一起，无法可靠处理重复点击、过期卡片、审批升级和发布超时。
2. **卡片只收集意见，管理员在后台手工发布。** 风险较低，但没有完成用户确认后自动同步知识库的核心闭环，也不能验证审批与行动层。
3. **先建设通用 BPM 工作流引擎。** 通用性过度，超出 20-30 人内部 MVP 的当前需要。Phase 5B 只实现一个受约束的通用行动聚合和首个 `publish_knowledge_draft` 执行器。

## 3. 宪法边界

- TypeScript Core 拥有卡片交互验证、授权决策、状态机和外部行动。
- Python AI Worker 只能生成或建议草稿，不能确认、批准、发布或调用飞书写接口。
- Postgres 是草稿、审批、行动、执行和发布事实的唯一权威来源。
- Redis 只承载异步交互任务；Redis 中的内容不能代替 Postgres 授权事实。
- 飞书卡片展示的是一个精确草稿修订版。确认行为只对该修订版有效。
- `suggestedPublication` 仅是建议，不能被执行器直接信任。最终目的地必须来自管理员授权的发布目标。
- 每次卡片展示、确认、批准和发布前都必须重新验证当前草稿、证据、权限和运行时门禁。
- 任何无法证明授权、身份、目标、幂等性或远端结果的情况都必须 fail closed。
- 草稿内容在成功发布前不能进入回答检索、向量索引或正式知识来源。
- 机器人不能代表人类确认自己的草稿。

## 4. 交付拆分与依赖

Phase 5B 分为三个连续、都必须完成的子阶段。拆分用于控制风险和评审范围，不代表删减核心功能。

### 4.1 Phase 5B-1：群内卡片确认事实

- 为当前知识草稿修订版生成飞书交互卡片。
- 发送卡片并记录展示事实。
- 接收新版 `card.action.trigger` 回调，在 3 秒内确认接收并异步处理。
- 支持“确认内容”“需要修改”“拒绝草稿”。
- 校验操作者身份、来源群成员资格、卡片版本和回调幂等性。
- 修改或拒绝沿用 Phase 5A 的治理状态机。
- 只记录群确认，不创建可执行发布行动，不写飞书知识库。

### 4.2 Phase 5B-2：通用审批与行动层

- 新增通用 `ActionProposal`、审批要求、批准、执行和事件事实。
- 首个行动类型为 `publish_knowledge_draft`。
- 按风险等级把群确认转化为已满足或待满足的审批要求。
- 向精确负责人或管理员发送绑定 proposal 的审批卡片，支持批准、要求修改和拒绝。
- 交付一个最小、已认证的完整正文审阅页，供超出卡片预算的草稿使用；它复用相同的 proposal 和审批事实，不另建旁路工作流。
- 生成不可变的审批快照，并在草稿变化时使旧审批失效。
- 不调用飞书知识库写接口。

### 4.3 Phase 5B-3：飞书知识库发布执行器

- 在执行前再次检查全部草稿、证据、身份、目的地、运行时和飞书权限。
- 创建知识库节点或文档并写入获批修订版的精确内容。
- 记录飞书节点、文档、版本和执行结果。
- 更新草稿为 `published`，并向来源群发送结果卡片。
- 对明确失败执行受控重试；对结果不确定的请求进入人工或自动对账，不盲目重试。

### 4.4 数据库迁移顺序

- Phase 5A 已使用 `0030_knowledge_draft_facts.sql`。
- Phase 5B-1 使用 `0031_knowledge_draft_presentations.sql`。
- Phase 5B-2 使用 `0032_action_approval_facts.sql`。
- Phase 5B-3 使用 `0033_knowledge_publications.sql`。

Phase 5B-1 尚未部署，因此其 `external_attempting` outbox 约束直接包含在 `0031_knowledge_draft_presentations.sql` 中；不得为它占用或新增任何 `0032_*` 迁移，`0032` 继续专用于 Phase 5B-2。

每个子阶段都必须有自己的单元测试、真实 Postgres 测试、运行手册和明确退出条件。完成一个退出条件后进入下一核心能力；非阻断加固项进入后续清单，不能无限延长当前子阶段。

## 5. 角色与授权

### 5.1 角色来源

- **来源群成员**：通过飞书实时群成员查询证明当前仍在草稿来源群。
- **指定负责人**：由当前草稿修订版的受信 reviewer 映射或管理员配置产生，不能只信模型文本。
- **Iris 管理员**：来自 Iris 当前管理员授权配置，并映射到精确飞书用户 ID。
- **发布执行器**：系统身份，只能执行已获批且满足所有门禁的行动，不能创建批准事实。

显示名称、卡片按钮值、模型返回角色和群聊中的自称都不是授权身份。

### 5.2 风险矩阵

| 风险级别 | 群确认 | 额外审批 | 可发布条件 |
| --- | --- | --- | --- |
| `low` | 当前来源群成员一次确认 | 无 | 群确认、当前证据和目的地均有效 |
| `medium` | 当前来源群成员一次确认 | 指定负责人批准 | 两项都满足，且负责人映射仍有效 |
| `high` | 当前来源群成员一次确认 | Iris 管理员或明确授权负责人批准 | 两项都满足，且高风险授权仍有效 |

补充规则：

- 没有来源群的公司级草稿不伪造群确认。它直接进入 `pending_review`，并由对应负责人或管理员审批。
- 中高风险草稿缺少可验证 reviewer 时保持 `pending_review`，不能降级为低风险或由任意群成员代替。
- 同一用户可以满足多个要求，仅当每个要求的角色校验都独立通过。
- 已离群、被撤销管理员权限或不再是负责人后，新的审批操作必须拒绝。
- 发布执行前会重算审批要求；授权配置变化可使尚未执行的审批快照失效。

## 6. 飞书卡片体验

### 6.1 卡片内容

卡片至少展示：

- Iris 标识和“知识草稿待确认”；
- 草稿标题；
- **当前修订版的完整正文**；
- 风险等级和需要的后续审批；
- 来源类型和有限的证据说明，不复制受保护原文；
- 目标知识库位置的可读名称；
- “确认内容”“需要修改”“拒绝草稿”三个动作；
- 草稿 ID、修订号和版本的可追溯摘要。

Phase 5B-1 卡片把上述摘要作为可见的固定 metadata 块展示：`Iris / pending_confirmation`、来源类型、草稿 ID、修订号和草稿版本。该块只使用有界事实字段，不复制来源群消息、证据标识或证据原文。

### 6.2 禁止确认截断内容

确认必须覆盖用户实际看到的全部正式内容：

- 正文能在卡片安全预算内完整展示时，确认按钮可用。
- 正文超过安全预算时，卡片只能显示摘要和“进入审阅”操作；“确认内容”按钮必须禁用。
- Phase 5B-2 的最小审阅页必须展示完整正文、风险、审批要求和内容哈希，并绑定同一修订号，才能完成确认或批准。
- 不能让用户在只看到省略号或摘要时批准隐藏正文。

Phase 5B-1 首先支持安全预算内的完整卡片。内部初始预算固定为正文最多 8,000 个 Unicode code point、序列化卡片 JSON 最多 24 KiB、组件最多 100 个；任一上限超出就视为超限，不尝试截断后确认。实现期合同测试还必须验证这些内部上限低于当前飞书真实接口上限。超限草稿保持 `pending_review`，不能发布，直到 Phase 5B-2 最小审阅页完成并通过验收。Phase 6 Admin Console 将扩展该页面的批量、筛选和配置能力，不重新定义审批事实。

### 6.3 修改与拒绝原因

- Core 服务端解析合同对“需要修改”和“拒绝草稿”保留 1-2,000 字符的规范化非空原因上限。
- Phase 5B-1 飞书卡片输入控件受平台合同限制，`max_length` 必须为 1,000，因此卡片 UI 实际只能提交 1-1,000 字符；不得向飞书发出无效的 2,000 字符控件上限。
- “拒绝草稿”还必须要求二次确认。
- Phase 5B-1 使用飞书 `form_submit` 按钮的原生 `confirm` 弹窗完成拒绝二次确认；飞书卡片 JSON 2.0 不接受 `checkbox` 标签，因此回调解析器只接受规范化非空原因，并仅在经过签名、身份与卡片绑定校验的 `reject` 回调上生成内部 `rejectionConfirmed=true` 事实。

### 6.4 已提交结果卡片

动作提交后，worker 的即时更新和 Postgres outbox dispatcher 的持久重试必须使用同一个确定性 renderer，并只读取 repository 返回/重读的已提交事实。确认结果显示 `Iris / confirmed`、来源类型、草稿 ID、修订号、版本、确认 actor/time 和下一门禁 `pending_review`；要求修改显示 `Iris / revision_requested`、相同绑定元数据、`needs_revision` 和已提交规范化原因；拒绝显示 `Iris / rejected`、相同绑定元数据、`rejected` 和已提交规范化原因。结果卡片不得包含正文、证据或来源原文，也不得从 callback 原始文本构造结果。outbox 重试必须产生字节等价结果，即使当前草稿随后已进入新修订。
- 卡片使用受限文本输入收集原因；Core 只保存规范化后的有界文本。
- “确认内容”不读取或保存原因输入框中的临时文本。
- 缺失、超限或结构异常的原因不会改变草稿状态。

### 6.3 版本绑定

每张卡片绑定：

- `draftId`；
- `revisionNumber`；
- 草稿 `version`；
- `presentationId`；
- 来源 `chatId`；
- 规范化卡片内容哈希。

按钮回传只携带这些不敏感标识和动作类型。Core 必须从 Postgres 重新读取正文、风险、证据和目标，不能信任回传正文或角色。

新修订版创建后，旧卡片立即逻辑失效。旧卡片点击返回“草稿已更新，请使用最新卡片”，不改变任何审批事实。系统尽力异步更新旧卡片为已过期，但安全性不依赖更新是否成功。

## 7. 卡片回调与异步入口

### 7.1 接收边界

新增独立的飞书卡片回调入口，与消息事件入口分开：

```text
POST /feishu/card-actions
```

Pilot Caddy 公网边界只精确代理已有 `POST /feishu/events` 和新增 `POST /feishu/card-actions`；`/internal/*`、Feishu 通配路径和其他未匹配路径继续返回 404。

入口职责仅包括：

1. 限制请求体大小；
2. 验证飞书签名、时间戳、应用身份和加密配置；
3. 解析最小回调信封；
4. 使用 Feishu `header.event_id` 建立幂等键；
5. 将原始最小任务写入专用 Redis 队列；
6. 在 3 秒内返回有效响应，并提示“已收到，正在核验”。

入口不读取大型草稿、不查询外部权限、不完成审批、不执行发布。

安全修正：启用 knowledge-card confirmation 时必须配置非空且有界的 `FEISHU_ENCRYPT_KEY`。卡片入口缺少 raw body、签名或时间戳，或签名/时间戳过期时，一律拒绝且不入队；该严格要求只作用于新版卡片入口，不能放宽或破坏旧 Feishu event callback 的兼容行为。

飞书新版加密卡片回调的签名输入必须兼容官方 SDK 语义：先按收到的原始 JSON 验签；若失败，再仅对同一个已解析 JSON 的 `JSON.stringify` 结果验签。两种路径都必须使用同一 `FEISHU_ENCRYPT_KEY`、300 秒以内时间窗和常量时间比较，解密后仍必须单独验证 Verification Token 与 `app_id`。该兼容只解决飞书服务端序列化空白差异，不能接受缺失签名、无 raw body、过期时间戳、未知应用或解密失败的请求。

如果 Redis 明确拒绝入队，入口仍在 3 秒内返回 HTTP 200，但 toast 必须明确显示“操作未提交，请稍后重试”，且 Postgres 不产生确认或审批事实。如果 1,000 ms 入队期限先到而 Redis 请求仍未完成，入口无法证明动作未提交，必须改为显示“提交状态未确认，请勿重复点击；请以卡片最终状态为准”；原来的单次幂等入队请求可以晚到成功，但入口不得自动发起第二次入队。这样既避免飞书重复回调风暴和用户重复点击，也不会把未持久化或结果未明的动作伪装成确定结果。

### 7.2 专用交互队列

使用独立 `approval-interactions` Redis 队列，不复用普通消息归一化流程。任务只包含完成处理所需的最小数据：

- 回调事件 ID；
- 应用 ID；
- 操作者飞书用户 ID；
- chat/message 标识；
- presentation ID；
- draft/revision/version 标识；
- 动作类型；
- 入队时间和尝试次数。

队列必须具备：

- pending、processing、delayed 和 DLQ 计数；
- 原子 claim/ack/retry；
- processing lease 与崩溃恢复；
- 指数退避和有上限的尝试次数；
- DLQ 查看、单条重放和删除接口；
- replay 不绕过业务幂等和当前权限校验；
- 日志不记录卡片正文、访问令牌或完整回调原文。

每次 processing lease 过期都必须在 Redis 原子恢复中消耗一次 attempt。达到第 5 次 lease 过期时任务进入确定性的、无正文 DLQ，不再回到 ready 队列；若任务随后由正常 worker 处理失败，不能对同一次尝试重复递增。

### 7.3 飞书官方接口约束

本设计以以下官方接口契约为基线：

- 新版卡片回调为 `card.action.trigger`，`header.event_id` 是回调唯一标识，业务服务器需要在 3 秒内响应：<https://open.feishu.cn/document/feishu-cards/card-callback-communication?lang=zh-CN>
- 回调无法同步完成业务时，可以先返回空响应，再异步更新消息卡片：<https://open.feishu.cn/document/server-docs/im-v1/faq?lang=zh-CN>
- 创建知识空间节点使用 `POST /open-apis/wiki/v2/spaces/:space_id/nodes`；当前公开请求字段没有可证明创建幂等性的业务 request ID：<https://open.feishu.cn/document/server-docs/docs/wiki-v2/space-node/create>

若飞书后续新增可靠的创建幂等键，执行器可以在保持本地 proposal/execution 契约不变的前提下采用它；在官方契约明确前继续使用 `reconciliation_required` 规则。

## 8. 展示与交互事实

### 8.1 `knowledge_draft_presentations`

记录一张已生成或已发送卡片的权威头部：

- `id`；
- `draft_id`、`revision_number`、`draft_version`；
- `chat_id`；
- `content_hash`；
- `state`: `pending_send`、`active`、`superseded`、`closed`、`send_failed`；
- 飞书 `message_id`；
- `created_at`、`activated_at`、`closed_at`；
- 乐观并发 `version`。

同一草稿修订版在同一群只能有一个 `active` 展示。创建新修订版会在同一事务中使已有 active 展示逻辑过期。

### 8.2 `knowledge_draft_presentation_events`

追加记录：

- `created`；
- `send_succeeded` / `send_failed`；
- `confirmed`；
- `revision_requested`；
- `rejected`；
- `superseded`；
- `card_update_succeeded` / `card_update_failed`。

每个事件包含 bounded actor、操作键、from/to version、回调事件 ID和时间。数据库约束阻止更新或删除历史。

### 8.3 展示发送 Outbox

卡片发送使用 Postgres outbox：草稿展示事实与待发送任务在同一事务提交，后台 dispatcher 再调用飞书。这样数据库提交成功但进程崩溃时不会永久丢失卡片。

发送 outbox 使用 `pending`、`processing`、`external_attempting`、`sent`、`failed`、`outcome_unknown` 状态和稳定幂等键。飞书消息发送发生超时、连接重置或 dispatch 后 generic fetch rejection 且结果未知时，先按可查询证据核对，不立即重复发送；`request_not_sent` 只保留给可证明的调用前失败。即使重复卡片最终不可避免，只有 Postgres 中的一个 active presentation 能产生有效确认。

## 9. 草稿生命周期扩展

Phase 5B 不新增容易混淆的草稿状态，继续使用白皮书已批准的五种状态。

```text
pending_confirmation
  -> group_confirmed -> pending_review
  -> revision_requested -> needs_revision
  -> rejected -> rejected

pending_review
  -> approval_requirements_satisfied -> pending_review
  -> publication_succeeded -> published
  -> revision_requested -> needs_revision
  -> rejected -> rejected

needs_revision
  -> revised -> pending_confirmation（来源群草稿）
             | pending_review（公司级草稿）

published / rejected -> terminal
```

说明：

- 低风险草稿被群确认后也先进入 `pending_review`。这里表示已离开群确认门槛，等待行动执行；只有飞书知识库写入成功才能进入 `published`。
- 中高风险草稿在额外审批完成后仍保持 `pending_review`，审批完成状态属于 ActionProposal，不滥用草稿状态表达。
- 发布失败或待对账时草稿保持 `pending_review`。
- 任意新修订都会取消未执行的旧 proposal、使旧审批和卡片失效，并重新计算风险要求。

新增草稿事件：

- `group_confirmed`；
- `review_approved`；
- `approval_invalidated`；
- `publication_requested`；
- `publication_succeeded`；
- `publication_failed`；
- `publication_reconciliation_required`。

## 10. 通用审批与行动模型

### 10.1 `action_proposals`

首个类型为 `publish_knowledge_draft`，字段包括：

- `id`；
- `action_type`；
- `subject_type` 和 `subject_id`；
- 精确 `subject_revision` 与 `subject_version`；
- `target_policy_id` 与目标策略版本；
- `status`: `pending_approval`、`approved`、`executing`、`succeeded`、`failed`、`cancelled`、`expired`、`reconciliation_required`；
- `operation_key`、`version` 和时间戳。

proposal 不复制未经校验的知识正文。它只引用获批草稿修订版和管理员授权的目标策略。

### 10.2 `action_approval_requirements`

创建 proposal 时保存当时要求的快照：

- `group_confirmation`；
- `designated_owner`；
- `iris_admin_or_authorized_owner`。

每个要求保存受信策略来源、精确角色引用和策略版本。执行前重算当前要求；快照和当前策略不一致时取消或失效 proposal，不能沿用旧授权。

### 10.3 `action_approvals`

每条批准记录：

- proposal 和 requirement ID；
- actor 类型和飞书用户 ID；
- 来源 presentation 或管理操作 ID；
- 被批准的 subject revision/version；
- 当前身份校验摘要；
- 唯一 operation key 和时间戳。

批准事实追加写入。撤权不删除历史，但会阻止未执行 proposal 继续，并记录 `approval_invalidated`。

### 10.4 `action_executions` 与 `action_events`

每次执行尝试记录：

- attempt number；
- `started`、`succeeded`、`failed` 或 `outcome_unknown`；
- 稳定请求指纹；
- 外部提供方和有限响应分类；
- 飞书资源标识（成功时）；
- 可重试时间或待对账原因；
- 不含令牌、全文和敏感原始响应。

proposal 和 execution 状态使用 compare-and-swap。只有一个 worker 能从 `approved` 进入 `executing`。

## 11. 发布目标策略

管理员预先配置允许写入的飞书知识库目标：

- 稳定 policy ID；
- 飞书 `space_id`；
- 可选 `parent_node_token`；
- 可读名称；
- 允许的来源群；
- 允许的风险等级；
- 是否启用；
- 策略 `version`；
- 创建/修改管理员和时间。

草稿修订版的 `suggestedPublication` 只能匹配一个已启用策略，不能动态创建任意目标。未匹配、目标被禁用、群不在 allowlist 或风险不兼容都保持 `pending_review`。

Phase 5B 不建设完整多租户策略系统。内部 MVP 使用单租户、少量显式目标；未来产品化时在不改变 ActionProposal 契约的前提下加入 tenant 维度。

## 12. 发布执行器

### 12.1 执行前门禁

执行器按顺序验证：

1. `globalEnabled=true`；
2. 来源群启用（存在来源群时）；
3. `writeKnowledgeBase=true`；
4. proposal 为当前 `approved` 且未过期；
5. 草稿仍为 `pending_review`，revision/version 精确匹配；
6. 所有证据仍为 current；
7. 所有文档证据通过飞书实时权限二重校验；
8. 当前风险和审批要求与快照一致；
9. 当前操作者授权和发布目标策略仍有效；
10. 同一 draft/revision 尚无成功发布或待对账执行；
11. 飞书应用仍有目标父节点编辑权限。

任一失败都不调用写接口，并记录稳定、有限的拒绝分类。

### 12.2 写入顺序

执行器只发布审批覆盖的精确 revision：

1. 对标题和 Markdown 内容做确定性转换；
2. 创建知识库节点或文档容器；
3. 写入完整正文；
4. 查询并记录当前文档/节点版本；
5. 在本地事务中写 publication 事实、完成 execution/proposal、将草稿置为 `published`、创建结果 outbox；
6. 异步将结果卡片发回来源群。

如果飞书接口需要多步创建，任何已创建但未写完的远端资源都记录为部分执行，不伪装成功。恢复流程优先补全或清理同一资源，不再创建第二份文档。

### 12.3 失败分类

- `rejected_before_request`：本地门禁失败；不重试，等待修订或管理员处理。
- `retryable_not_sent`：可以证明请求未到达飞书；按上限退避重试。
- `remote_rejected`：飞书明确返回权限、参数或业务拒绝；不自动无限重试。
- `retryable_remote_failure`：飞书明确表示未创建且可重试；受控重试。
- `outcome_unknown`：超时、连接中断或响应解析失败，无法证明远端是否成功；进入 `reconciliation_required`。

飞书公开的“创建知识空间节点”请求当前没有 Iris 可以证明的业务幂等键。因此 `outcome_unknown` 禁止盲目重放创建请求。对账通过查询目标父节点、稳定标题标记和本地请求指纹寻找唯一资源；无法唯一确认时必须由管理员处理。

## 13. 发布事实

`knowledge_publications` 每个 draft/revision 最多一条成功记录：

- proposal 和 execution ID；
- draft/revision/version；
- target policy ID/version；
- 飞书 `space_id`、`node_token`、文档 token/type；
- 飞书文档版本；
- 发布内容哈希；
- `published_at`；
- 最后一次权限校验摘要。

唯一约束覆盖 `(draft_id, revision_number)`。published 草稿不可创建新 revision；后续“更新已发布知识”必须创建新的更新 proposal，而不是篡改历史 publication。

## 14. 卡片结果回写

交互 worker 完成后异步更新卡片：

- 已确认：显示确认人、确认时间和下一门槛；
- 需要修改：显示已进入修改状态和有界原因；
- 已拒绝：显示拒绝状态；
- 过期：提示使用最新卡片；
- 已发布：显示目标知识库和安全链接；
- 发布失败：显示“未发布”及可操作的有限原因；
- 待对账：显示“结果待核验，请勿重复发布”。

卡片回调令牌有时效且更新次数有限，因此 Postgres 状态永远是事实源。更新卡片失败只产生审计/重试，不回滚已正确提交的确认或发布事实。

## 15. 内部 API 与控制面

所有内部 API 继续使用现有 internal bearer token，并执行请求体、分页和日志边界。

### 15.1 Phase 5B-1

- `POST /internal/knowledge-drafts/:id/presentations`：创建并入队一张当前修订版卡片；
- `GET /internal/knowledge-drafts/:id/presentations`：查看展示历史；
- `GET /internal/approval-interactions/status`：队列计数；
- `GET/POST/DELETE /internal/approval-interactions/dead-letters...`：受控 DLQ 管理。

### 15.2 Phase 5B-2

- `GET /internal/action-proposals`；
- `GET /internal/action-proposals/:id`；
- `POST /internal/action-proposals/:id/request-revision`；
- `POST /internal/action-proposals/:id/reject`；
- `GET /internal/action-proposals/:id/events`。

负责人和管理员的人工批准只接受新版飞书卡片回调中经过验证的真实用户身份。Phase 5B 不提供“传入 actorId 即批准”的 internal API；现有 internal bearer token 只能执行系统治理和运维操作，不能伪装为 reviewer。最小审阅页的链接只用于定位 proposal，页面必须完成飞书 OAuth 身份校验后才能展示正文，且登录用户必须与当前审批要求匹配；链接本身不是授权凭证。审阅完成后，用户回到审批卡片点击批准，最终批准仍由经过验证的卡片回调提交到同一个 Approval Service。Phase 6 只有在引入受信管理员用户会话后，才能增加 Web 批准入口。

### 15.3 Phase 5B-3

- `POST /internal/action-proposals/:id/execute`：只入队已获批行动，不同步执行外部写入；
- `GET /internal/action-executions/status`；
- `GET /internal/knowledge-publications/:draftId`；
- `POST /internal/action-executions/:id/reconcile`：管理员触发受控对账，不直接标记成功。

公开入口只暴露飞书回调和 `/health`。所有 `/internal/*` 必须在 Caddy 公网边界保持 404。

## 16. 幂等与并发

- 回调接收幂等键：`feishu-card:{appId}:{eventId}`。
- 卡片动作幂等键：`presentation:{presentationId}:{eventId}:{action}`。
- 展示发送幂等键：`knowledge-presentation:{draftId}:{revision}:{chatId}`。
- proposal 幂等键：`publish-knowledge:{draftId}:{revision}:{targetPolicyVersion}`。
- 审批幂等键：`approval:{proposalId}:{requirementId}:{actorId}:{operationKey}`。
- execution 使用 proposal 的稳定请求指纹和原子状态领取。

同一 `operationKey` 以完全相同请求重放时返回已提交结果；相同 key 携带不同 payload 时返回冲突。并发确认、修改、拒绝或执行由 Postgres version/CAS 和唯一约束裁决，不依赖进程内锁。

## 17. 安全、隐私与审计

- 回调签名失败、时间戳越界、未知 app、缺失 event ID 或未知 presentation 一律拒绝业务处理。
- 回调快速响应不能把“已收到”表述为“已批准”或“已发布”。
- 不在 Redis、普通日志、错误响应和审计摘要中复制完整草稿正文或证据原文。
- 审计保留谁、何时、对哪个 revision、以什么角色完成了什么动作，以及门禁结果。
- API 错误只返回稳定分类，不泄露草稿是否存在于另一个群或用户是否接近满足某角色。
- 发布结果链接只发送到允许的来源群和受信管理面。
- 来源证据失效后，尚未发布的草稿继续沿用 Phase 5A 的内容脱敏规则；卡片不再提供内容确认。
- 发布后撤销来源权限不删除已发布知识。它触发后续知识冲突/撤回治理流程，不能静默篡改历史。

## 18. 运行时门禁与 rollout

新增默认关闭的运行时配置：

- `IRIS_KNOWLEDGE_CARD_ENABLED=false`；
- `IRIS_APPROVAL_ACTIONS_ENABLED=false`；
- `IRIS_KNOWLEDGE_PUBLICATION_ENABLED=false`；
- 卡片来源群 allowlist；
- 行动来源群 allowlist；
- 发布来源群 allowlist。

三个门禁逐层依赖，后层不能绕过前层。`writeKnowledgeBase` capability 继续默认 `false`，只有 Phase 5B-3 真实门禁全部通过后才对 pilot 群开启。

关闭全局或群级 Iris 时：

- 新卡片不发送；
- 新确认/批准不改变业务状态；
- 新发布不启动；
- 已领取但尚未调用外部接口的执行立即停止；
- 已发出且结果未知的执行进入对账，不能假装被回滚。

## 19. 可观测性

状态接口和部署门禁必须覆盖：

- approval interaction queue pending/processing/delayed/DLQ；
- presentation outbox `pending`/`processing`/`external_attempting`/`failed`/`outcome_unknown`（可附带 `sent` 和 terminal-failed 细分）；
- action proposal 各状态计数；
- action execution pending/executing/failed/reconciliation_required；
- result notification outbox；
- 最近一次成功交互、审批、发布和对账时间；
- bounded failure classification；
- 当前候选提交和 Core 镜像 SHA。

状态和 telemetry 只暴露有界计数与稳定分类，不包含草稿正文、证据正文或原因文本。健康检查不因为一个业务 proposal 被拒绝而整体 unhealthy，但 knowledge-card readiness 在 outbox 状态不可读、存在未解决 `outcome_unknown`、或存在 terminal/exhausted failed 行时必须 fail closed。普通 `pending`、`processing`、`external_attempting` 可重试工作不构成永久 enable blocker；pilot 前置验收仍应先等待这些队列排空。基础队列不可达、迁移缺失、worker 未运行或启用发布却缺少必要飞书配置时也必须失败。

## 20. 测试策略

### 20.1 单元与组件测试

- 风险矩阵和角色校验；
- 卡片内容完整性和超限禁用确认；
- 签名、时间窗、app、event ID 和 payload 边界；
- callback 3 秒内 ack，慢查询只发生在 worker；
- 重复回调、重复点击和冲突 payload；
- stale revision/version/presentation；
- 新 revision 使卡片、审批和 proposal 失效；
- 群成员、负责人和管理员撤权；
- 运行时各层关闭时 fail closed；
- 卡片更新失败不回滚确认事实。

### 20.2 Postgres 集成测试

- 0031-0033 migration 和 rollback contract；
- append-only 事件与审批；
- CAS、唯一约束和 operation key 冲突；
- 同事务 outbox；
- 并发确认/修改/拒绝；
- 并发执行只能一个 worker 领取；
- 成功 publication 与草稿 `published` 原子落库；
- 真实 Postgres 重启后事实仍存在。

### 20.3 Redis 与 worker 测试

- claim/ack/retry/DLQ/replay；
- processing lease recovery；
- retry 排序与上限；
- worker 崩溃后不丢回调；
- replay 仍重跑当前授权校验；
- 所有队列最终 pending/processing/delayed/DLQ 为 0。

### 20.4 飞书适配器合同测试

- 卡片 JSON 2.0 结构；
- 新版 card callback 信封；
- 发送、更新和回调响应边界；
- 创建节点、写正文、读取版本；
- 权限拒绝、限流、明确失败、超时和畸形响应；
- timeout 后进入 `reconciliation_required`，不重复创建。

### 20.5 真实 pilot 验收

在 global/group/capability 全部默认关闭的前提下：

1. pilot 群只开启 5B-1，验证确认、需要修改、拒绝和 stale card；
2. 开启 5B-2，验证 low/medium/high 风险矩阵和撤权；
3. 配置唯一测试知识库目标并开启 5B-3；
4. 发布唯一验收标记，确认飞书正文、节点、版本和回群结果；
5. 注入一次明确失败和一次模拟 outcome unknown，确认无重复文档；
6. 确认非 pilot 群无卡片、无 proposal、无发布；
7. 确认全部队列和 DLQ 为 0；
8. 关闭 runtime 后再次点击旧卡片，确认不产生业务状态变化。

真实验收需要用户发送或点击飞书消息时，Iris 必须明确报告唯一动作并等待真实证据，不能自行判定通过。

## 21. 部署与回滚

每个子阶段使用相同流程：

1. 合并前要求 Core 和 AI Worker GitHub checks 为 success；
2. 备份数据库并验证迁移；
3. 部署与批准提交相同 SHA 的 Core 镜像；
4. 保持新门禁关闭，核对服务健康和全部队列为 0；
5. 只对 pilot 群打开当前子阶段门禁；
6. 完成真实验收后才进入下一子阶段；
7. 出现权限、重复写、数据丢失、状态机或核心崩溃问题立即关闭门禁并回滚代码；
8. 已执行的外部写入不通过数据库回滚伪装撤销，必须记录并按治理流程处理。

数据库迁移只向前演进；回滚应用时保持新增事实表，由旧版本忽略。不得为了回滚代码删除审计、审批或发布历史。

## 22. Phase 5B 完成定义

只有同时满足以下条件，Phase 5B 才能标记完成：

- pilot 群能收到绑定精确修订版的完整交互卡片；
- 确认、需要修改、拒绝和过期卡片都经过真实飞书验收；
- low/medium/high 风险审批矩阵通过自动和真实验收；
- 未经所需人类确认或当前权限无效时不能写知识库；
- 成功发布后飞书正文、节点、版本、本地 publication 和回群结果一致；
- 重复回调、重复点击、重启、并发 worker 和受控重试不会产生重复正式文档；
- 结果不确定时进入待对账而不是盲目重试；
- runtime disable 后不再确认、不再批准、不再启动发布；
- 公网 `/internal/*` 继续为 404；
- 所有相关 pending/processing/delayed/DLQ 为 0；
- Core、AI Worker、数据库、Redis 和 Caddy 健康；
- 部署日志、验收证据、批准提交和镜像 SHA 一致；
- PR 和实现提交已推送 GitHub。

完成上述闭环后，应转向白皮书中下一个缺失核心能力。与安全发布无关的性能优化、额外卡片样式、批量审批和多租户扩展进入后续 backlog，不得形成无限硬化循环。

## 23. 非目标

- 不在 Phase 5B 自动生成知识草稿；该能力属于后续模型生成阶段。
- 不建设通用 BPM、条件表达式语言或任意插件执行系统。
- 不支持跨租户、多公司安装和计费。
- 不允许模型直接选择 reviewer、管理员或任意知识库目的地。
- 不把草稿、审批评论或未发布正文加入回答检索。
- 不自动修改或删除既有正式知识页面。
- 不用高频重试掩盖飞书限流、权限问题或结果不确定。
- 不为了增加测试数量无限扩展当前阶段；退出条件通过后继续核心产品闭环。

## 24. 后续演进信号

- 当第二种高影响行动出现时，复用 ActionProposal 契约并新增专用 executor，不复制审批逻辑。
- 当 20-30 人内部使用产生真实批量需求后，再增加批量审阅和通知聚合。
- 当管理员需要日常处理超长草稿、待对账执行或 reviewer 映射时，Phase 6 Admin Console 复用本设计的事实和 API。
- 当出现多个公司安装时，为策略、proposal、approval、execution 和 publication 增加 tenant 维度及强制数据库隔离。
- 当知识发布量或飞书同步成为独立瓶颈时，按白皮书演进标准拆出 Knowledge Sync Service；事实契约和 fail-closed 行为保持不变。
