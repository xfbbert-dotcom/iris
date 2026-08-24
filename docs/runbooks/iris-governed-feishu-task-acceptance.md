# Iris 受治理飞书任务创建验收手册

> 工单：`IRIS-MKU-20260822T045259Z`。本手册只验收一个受治理的 `create_feishu_task`
> 闭环。自动化测试、内部 API 写入或数据库修补都不能替代真人确认、OAuth 审阅和批准。

## 1. 验收边界与退出条件

- 只使用一个明确 allowlist 的 pilot 群、一个真实请求者和一个真实任务负责人。
- 请求者在群里明确要求 Iris 起草一个任务；负责人必须是任务唯一 assignee，并亲自完成
  OAuth 审阅和批准。机器人、管理员代批和内部 API 伪造均不算通过。
- 候选提交、Core 镜像标签和实际运行镜像必须是同一个不可变 SHA；相关 CI 全部成功。
- 只允许创建一个全新、可安全删除或关闭的验收任务。不得复用已有任务或生产交付事项。
- 开始和结束时必须为安全关闭：global 与全部已知群 disabled，`readGroupContext=false`、
  `replyWhenMentioned=false`、`generateTaskDrafts=false`、`createFeishuTasks=false`、
  `callExternalTools=false`，任务创建 env disabled 且 allowlist 为空。
- formal-task pending/claimed/external-attempting/failed/outcome-unknown/reconciliation-required、
  result pending/processing/failed/outcome-unknown，以及相关队列/DLQ 最终全部为 `0`。
- 任何身份、版本、哈希、成员关系、迁移、运行时、外部回读或计数不一致时立即回滚，
  不尝试用新任务掩盖失败。非阻断的界面和性能改进记入后续清单。

## 2. 自动化候选门禁

在候选 SHA 的干净工作树运行，全部退出 `0`：

```powershell
npm run verify
npm run pilot:config
npm run typecheck --workspaces --if-present
npm run build --workspaces --if-present
npm test --workspaces --if-present -- --reporter=dot
git diff --check
```

`deploy/pilot/ci.env` 必须保持任务创建 disabled、allowlist 为空。自动化门禁通过只表示默认
关闭的代码候选可部署，不表示真实任务已经创建或验收。

## 3. 部署前只读核对

1. 核对候选 SHA、Core 镜像摘要、CI 状态和加密备份校验值；验收记录不得包含 secret。
2. 通过受保护的内部状态接口确认 global/群/capability 全部关闭、所有相关队列为零。
3. 确认迁移历史精确包含一次 `0057_governed_feishu_task_actions.sql`，append-only 保护存在。
4. 只查询 ID、状态、版本、哈希、时间和计数。不得把任务正文、assignee open ID、OAuth
   token、Cookie、远端任务 GUID/URL 或飞书响应正文写入日志、命令历史或验收附件。

默认关闭部署配置为：

```text
IRIS_FEISHU_TASK_CREATION_ENABLED=false
IRIS_FEISHU_TASK_CREATION_GROUP_ALLOWLIST=
```

先以该状态迁移和启动同 SHA Core。只有 live readiness 没有迁移、worker、unknown 或恢复类
失败时，才进入受控窗口。

## 4. 打开唯一受控窗口

将部署环境显式设置为：

```text
IRIS_FEISHU_TASK_CREATION_ENABLED=true
IRIS_FEISHU_TASK_CREATION_GROUP_ALLOWLIST=<唯一 pilot 群>
```

同时开启现有 knowledge-card、action approval 和 OAuth review 的同群边界。重建 Core 后仍保持
global/群/capability disabled，确认：

- task creation runtime 只识别一个群且 worker running；
- knowledge-card、action-approval、action-review 均 healthy；
- `readGroupContext`、`replyWhenMentioned`、`generateTaskDrafts`、`createFeishuTasks`、
  `callExternalTools` 仍为 false；
- 非 pilot 群和全部未知群继续 fail closed。

在上述 durable gate 仍全部关闭时，为 pilot 群选用稳定不变的 policy ID，并先调用 bearer
保护的 `GET /internal/formal-task-policies/:id`：

- 若返回 404，本次是首次创建，`expectedVersion` 使用 `0`；
- 若返回 200，本次是回滚后的重跑或策略更新，`expectedVersion` 必须使用响应中的当前精确
  `policy.version`，并完整替换策略字段；
- 其他响应均停止，不得猜测版本、改换 policy ID 或直接写表。

然后调用 `PUT /internal/formal-task-policies/:id` 启用本轮唯一任务目标策略。请求必须携带
`x-iris-operator`，并精确提供以下字段（尖括号项先替换为上一步确定的实际值）：

```text
{
  "sourceGroupId": "<唯一 pilot 群>",
  "displayName": "Controlled Feishu task pilot",
  "allowedAssigneeOpenIds": ["<唯一真实负责人>"],
  "maxDueHorizonDays": 30,
  "enabled": true,
  "expectedVersion": <首次为 0；重跑时为 GET 返回的当前整数版本>,
  "operationKey": "<本次逻辑更新的唯一操作键>"
}
```

负责人必须是实时读取到的当前群成员且不能是机器人。一次逻辑更新的网络重试必须复用完全
相同的请求正文、`expectedVersion` 和 `operationKey`；只有新的逻辑更新才读取最新版本并生成新
`operationKey`。不得直接写表。通过
`GET /internal/formal-task-policies/:id` 复核 `enabled=true`、版本和
`allowedAssigneeCount=1`。接口响应不返回负责人 open ID；命令输出和验收附件也不得记录群 ID、
负责人 ID 或请求正文。

随后只对唯一 pilot 群开启 global、群以及上述五个 capability。每次开关后重新读取 live
status/readiness；不得依赖启动时缓存或旧 OAuth 会话。

## 5. 真人成功闭环

1. 真实请求者在 pilot 群发送明确的单任务起草请求，指定唯一真实负责人，可选一个 due
   time 和至多一个提醒。普通问答、模型抽取或管理员控制台不得直接创建远端任务。
2. 核对只新增一个 formal-task draft。群卡片显示受限标题/描述、负责人显示引用、due、
   reminder、证据计数、风险、revision 和 task-spec hash 指纹。
3. 一名当前群成员在最新群卡片确认；旧卡、非成员、机器人和重复点击必须 fail closed 或
   幂等。确认后只生成一个绑定当前 draft/version/hash 的 `create_feishu_task` proposal。
4. 唯一 assignee 从私聊审批卡打开审阅页，完成飞书 OAuth。页面显示的 task spec、目标
   指纹、proposal/draft 版本和 64 位小写 SHA-256 必须与确认事实精确一致。
5. assignee 亲自提交审阅事实并在最新审批卡批准。其他成员、管理员代批、未审阅批准、
   stale 页面/卡片、撤权后批准和 disabled 后批准必须被拒绝且不创建 execution。
6. 等待一个 execution 成功。执行器必须复用同一个确定性 client token；超时或不确定
   结果只能以相同 token/payload 回查，禁止盲目创建第二个任务。
7. 使用飞书官方 Task v2 读取接口精确回读新任务，人工核对标题、描述、唯一 assignee、
   due/reminder 与已批准 task-spec 一致。验收记录只写“匹配/不匹配”和哈希，不写正文、
   人员 ID、任务 GUID 或 URL。
8. pilot 群只收到一个终态结果卡；重复 worker 周期、回调或回查不产生第二个远端任务、
   success fact 或结果卡。

## 6. 必须保留的负向证据

- 在 capability 或 env disabled 时，明确请求最多形成允许的本地事实，不得发卡/审批/外调。
- 非 allowlist 群执行同类请求不形成可执行 proposal，不调用 Task v2。
- 未审阅、非 assignee、非成员、旧 revision/version/hash、策略变更或成员撤销后批准均拒绝。
- 若模拟网络 outcome unknown，只能把现有 execution 安全重新排入回查；Admin Console 的
  reconcile 入口不得创建新 execution 或改变 client token/payload。

负向用例不得通过删除 append-only 事实“恢复”。每个用例结束后先排空在途项，再开始下一项。

### 6.1 权限拒绝误判的受限收口

仅当旧版本把飞书“应用未开通所需权限”误判为未知结果，并最终耗尽回查预算时，才允许使用
`POST /internal/formal-task-executions/:id/resolve-permission-denied`。操作前必须同时确认：

- execution 为 `reconciliation_required`，原因是 `reconciliation_budget_exhausted`；
- execution 不含任何远端任务 GUID、ID 或 URL，且不存在 `feishu_task_creations` 事实；
- 飞书官方响应已确认是创建前的权限拒绝，证据码只能提交
  `feishu_permission_denied`；
- 请求携带精确 execution version、唯一 operation key 和当前 operator 身份。

该动作只把原 execution 与 proposal 终态化为 `failed`，并追加 `failed`/`execution_failed`
审计事件；不得删除历史、伪造成功、重新发送旧任务或复用它规避新的真人请求与审批。任一条件
不满足时必须保持 `reconciliation_required`，等待人工核查远端任务。

## 7. 内容无关证据模板

仅在私有验收记录填写以下字段：

```text
ticket=IRIS-MKU-20260822T045259Z
candidate_sha=<40-hex>
core_image_digest=<digest>
ci_core=<success>
backup_sha256=<64-hex>
migration_0057_count=1
pilot_group_count=1
real_requester_present=true
group_confirmation_present=true
assignee_oauth_review_present=true
assignee_approval_present=true
task_spec_hash_match=true
feishu_readback_match=true
remote_task_count=1
success_fact_count=1
result_card_count=1
unknown_or_reconciliation_count=0
queue_or_dlq_count=0
rollback_safe_off=true
```

不要填写真实群 ID、人员 ID、正文、due 值、远端 GUID/URL、token、Cookie 或响应正文。

## 8. 固定回滚

完成或任一失败后按顺序执行：

1. durable-disable `callExternalTools`、`createFeishuTasks`、`generateTaskDrafts`、
   `replyWhenMentioned`、`readGroupContext`，再 disable pilot 群与 global；等待当前已承诺的
   结果持久化完成，不接受新 claim。使用策略接口和
   当前精确版本把本轮任务目标策略更新为 `enabled=false`，保留版本与操作事实。
2. 将 `.env.pilot` 恢复为 `IRIS_FEISHU_TASK_CREATION_ENABLED=false` 和空 allowlist，重建
   Core；knowledge-card/action-approval/action-review 的临时同群配置也恢复为默认关闭。
3. 确认 live status/readiness 表示安全关闭，所有 formal-task/approval/card 队列、DLQ、
   unknown 和 reconciliation 计数为零。
4. 保留 append-only draft/proposal/review/approval/execution/success/event 事实，不手工改写。
   若一致性失败，使用部署前加密备份按既有恢复手册处理。
5. 验收任务按飞书中的正常人工流程关闭或删除；该清理不是 Iris 验收的一部分，也不得用来
   隐藏重复创建。

只有真人闭环、精确回读、幂等计数和最终安全关闭全部通过，才能把 task creation 标记为
“真实 pilot 通过”。否则状态保持“代码候选与自动门禁完成，真实验收待执行”。

## 9. 后续清单（不阻断本阶段）

- 将共享审批 worker 的终态卡片标题和 execution observation reason 按 action type 区分；
  `create_feishu_task` 不再沿用 knowledge publication 的展示措辞。该项仅影响运维可读性，
  不改变批准、权限、执行或幂等事实，因此不延长本阶段退出门禁。
- 将成员查询故障和运行时暂停改为复用同一个未发送 execution，或单独记录有界管理重试；
  避免长期暂停时增长 execution 链，并让 `attemptNumber` 只表达真实外部请求尝试。当前实现会在
  due 过期时以 `due_expired` 可见终态停止，不会越过发送边界或无限期保留 executing proposal。
