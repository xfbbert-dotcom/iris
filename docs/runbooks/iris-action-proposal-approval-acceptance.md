# Iris Phase 5B-2A 行动提案与人工审批验收手册

> 本手册只验收 `publish_knowledge_draft` 的 `ActionProposal`、风险分级、审批要求、飞书审批卡片和治理操作。它不包含 Phase 5B-2B 完整正文 OAuth 审阅页，也绝不创建或写入飞书知识库；知识库写入属于 Phase 5B-3。

## 1. 验收边界

- 真实灰度开始前，必须有唯一候选提交 SHA，Core 与 AI Worker 镜像必须是同一 SHA，GitHub Core/AI Worker checks 必须为 `success`。
- 未经明确合并授权，不合并本 PR 或其基线 PR。
- 所有令牌、密钥、草稿正文、证据正文、回调原文和审批原因不得进入命令历史、普通日志、验收记录或 PR。
- 所有新门禁默认关闭：`IRIS_APPROVAL_ACTIONS_ENABLED=false`，`IRIS_APPROVAL_ACTION_GROUP_IDS=`。
- 只允许一个当前 pilot 群；所有其他当前群和历史已知群必须保持 runtime disabled。
- 飞书卡片只用于真实身份审批。内部 bearer API 不得接受或伪造人工批准事实。
- 任一身份、权限、版本、幂等、数据丢失、状态机、队列或核心崩溃异常都立即关闭窗口，不带病继续。
- 本阶段的退出条件一旦通过，进入 5B-2B；卡片样式、批量审批、多租户和非阻断性能优化进入 backlog，不延长 5B-2A。

## 2. 本地退出门禁

在仓库根目录运行，所有命令必须退出 `0`：

```powershell
git diff --check
npm run typecheck
npm run build
npm test
npm run test:python
npm run test:pilot
npm run pilot:config
npm run readiness -- --env-file deploy/pilot/ci.env
```

`deploy/pilot/ci.env` 和仓库 `.env.example` 必须保持：

```text
IRIS_KNOWLEDGE_CARD_ENABLED=false
IRIS_KNOWLEDGE_CARD_GROUP_IDS=
IRIS_APPROVAL_ACTIONS_ENABLED=false
IRIS_APPROVAL_ACTION_GROUP_IDS=
IRIS_REVIEW_PUBLIC_ORIGIN=
```

## 3. 部署前 fail-closed 核对

先停止 Caddy。保持 global、所有已知群、`generateKnowledgeDrafts`、`writeKnowledgeBase` 均 disabled，并保持 5B-1/5B-2A 环境门禁关闭。只读确认：

1. Core、Postgres、Redis、AI Worker healthy；migration 容器退出 `0`。
2. `APPROVED_COMMIT_SHA`、`IRIS_IMAGE_TAG`、Core 镜像标签和 AI Worker 镜像标签精确等于候选 SHA。
3. `0030`、`0031`、`0032` 已按顺序存在；不得修改已应用迁移。
4. event、document-sync、reindex、approval-interaction 的 pending/processing/delayed/DLQ 全为 `0`。
5. knowledge-card 与 action-approval outbox 的 pending/processing/external_attempting/outcome_unknown/terminalFailed 全为 `0`；`sent` 是历史审计计数，不要求清零。原始 `failed` 可包含 `superseded`、`presentation_superseded` 或 `governance_disposition` 等非故障历史，但 `terminalFailed` 必须为 `0` 且不得大于 `failed`。
6. action proposal 的历史状态计数可读，且不存在 `executing` 或 `reconciliation_required`。
7. `action_executions` 没有本阶段创建的记录；不存在任何 Wiki node/document 写入尝试。

使用内部 bearer 只读取有界状态，不读取正文：

```powershell
$headers = @{ authorization = "Bearer $env:IRIS_INTERNAL_API_TOKEN" }
$status = Invoke-RestMethod -Headers $headers -Uri http://localhost:3000/internal/status
$runtime = Invoke-RestMethod -Headers $headers -Uri http://localhost:3000/internal/runtime-control/status
$approvalQueue = Invoke-RestMethod -Headers $headers -Uri http://localhost:3000/internal/approval-interactions/status

if ($status.status -ne "healthy") { throw "Core is not healthy" }
if ($runtime.persistence.ok -ne $true) { throw "Runtime-control persistence is unavailable" }
if ($runtime.globalEnabled -ne $false -or $runtime.desiredGlobalEnabled -ne $false) {
  throw "Global Iris is not durably disabled"
}
if ($runtime.capabilities.generateKnowledgeDrafts -ne $false) {
  throw "Knowledge-draft generation is not disabled"
}
if ($runtime.capabilities.writeKnowledgeBase -ne $false) {
  throw "Knowledge-base writes are not disabled"
}
foreach ($name in @("pending", "processing", "delayed", "deadLetter")) {
  if ([long]$approvalQueue.$name -ne 0) { throw "Approval interaction $name is not zero" }
}
```

## 4. 单群配置与开启顺序

私下配置 `.env.pilot`，不得回显整个文件：

```text
IRIS_KNOWLEDGE_CARD_ENABLED=true
IRIS_KNOWLEDGE_CARD_GROUP_IDS=<唯一 pilot 群 ID>
IRIS_APPROVAL_ACTIONS_ENABLED=true
IRIS_APPROVAL_ACTION_GROUP_IDS=<同一唯一 pilot 群 ID>
IRIS_REVIEW_PUBLIC_ORIGIN=
```

5B-2A 不需要公开审阅页，因此 `IRIS_REVIEW_PUBLIC_ORIGIN` 保持空。重建 Core 后仍保持 global 与所有群 disabled、Caddy stopped。此时：

- `actionApprovals.enabled=true`；
- planner 与 dispatcher 均 `running=true`；
- `enabledGroupCount=1`；
- readiness 的 `actionApprovals` 为 `pass`；
- 共享 callback worker 正常，但 runtime/group gate 会阻止业务变更；
- 公开入口仍不可达。

随后按顺序：

1. 创建或更新唯一测试目标策略，绑定 pilot 群和本轮所需风险等级；使用精确 `expectedVersion`、唯一 `operationKey` 和 `x-iris-operator`。
2. 仅为本轮高风险用例创建所需 grant；每次更新都使用精确版本和唯一 operation key。
3. 只启用 pilot 群的 group runtime 与 `generateKnowledgeDrafts`；所有非 pilot 群仍 disabled，`writeKnowledgeBase=false`。
4. 最后启用 global runtime，再启动 Caddy。
5. 从公网验证 `/health=200`、`/internal/*=404`、只有精确 `/feishu/events` 与 `/feishu/card-actions` 能到达 Core。

策略与 grant 只通过内部治理接口写入；下面仅展示结构，不放真实 Open ID：

```powershell
$operatorHeaders = @{
  authorization = "Bearer $env:IRIS_INTERNAL_API_TOKEN"
  "x-iris-operator" = "action-approval-pilot"
}

$policyBody = @{
  spaceId = $env:IRIS_TEST_WIKI_SPACE_ID
  displayName = "Iris 5B-2A pilot target"
  allowedGroupIds = @($env:IRIS_PILOT_GROUP_ID)
  allowedRiskLevels = @("low", "medium", "high")
  enabled = $true
  expectedVersion = 0
  operationKey = "pilot-policy-create-$env:IRIS_APPROVED_COMMIT_SHA"
} | ConvertTo-Json -Compress

Invoke-RestMethod -Method Put -Headers $operatorHeaders `
  -Uri http://localhost:3000/internal/action-policies/iris-pilot `
  -ContentType "application/json" -Body $policyBody
```

## 5. 真实飞书验收矩阵

每个用例使用独立测试草稿，绑定精确当前 revision/version/evidence。每次只操作一张最新卡片，等待共享 callback queue 与两个 presentation outbox 的在途计数归零后再进入下一例。

### 5.1 低风险自动满足

1. 在 pilot 群完成一个 low-risk 草稿的群确认，使其进入 `pending_review`。
2. planner 只创建一个 proposal。
3. proposal 直接为 `approved`，`group_confirmation` requirement 为 `satisfied`。
4. 不创建额外 action approval presentation，不向负责人发送审批卡片，也不新增 `action_approvals` 人工批准行。

### 5.2 中风险精确负责人

分别使用三个独立 medium-risk 草稿：

1. **批准**：只有草稿当前精确 `feishu_user` reviewer 收到并能批准；proposal 进入 `approved`，只新增一条对应 approval。
2. **要求修改**：负责人提交非空有界原因；草稿进入 `needs_revision`，proposal `cancelled`，pending requirements `invalidated`，不新增人工批准行。
3. **拒绝**：负责人在飞书原生二次确认后拒绝；草稿进入 `rejected`，proposal `cancelled`，不新增人工批准行。

非负责人点击相同卡片必须 denied，且 proposal、requirement、draft、approval 和 event 均不变化。

### 5.3 高风险当前授权

使用独立 high-risk 草稿验证：

1. 当前 `iris_admin` grant 的用户可以批准。
2. 当前精确 reviewer 且同时持有 `authorized_high_risk_owner` grant 的用户可以批准。
3. 在卡片发送后撤销 grant，再点击旧卡必须 denied；不得依赖卡片生成时的旧角色快照放行。
4. 只有 reviewer、但没有当前高风险 grant 的用户不能批准。

### 5.4 stale、幂等和运行时负向门禁

1. 分别改变 draft revision/version、target policy version、proposal version 后点击旧卡，全部必须 denied 且无业务 mutation。
2. superseded/closed/wrong-recipient presentation 必须 denied。
3. 同一 callback event 精确重放只产生一次业务事实；相同幂等键携带不同 intent 必须 conflict，不能返回旧成功。
4. 停用 pilot group 或 global runtime 后点击旧卡必须 denied，且不新增 approval/event。
5. 每个当前非 pilot 群都必须没有 proposal、approval presentation 或 action approval；历史群只要求持续 disabled，不伪造真人消息。
6. 内部 API 的 request-revision/reject 只能生成治理 disposition，不能写入 `action_approvals`，也不能伪造 reviewer。

## 6. 事实核对

只查询 ID、版本、状态、actor、角色摘要、时间和计数，不选择知识草稿正文、证据正文或原因文本。每个用例至少核对：

- `action_proposals` 只有一个 live subject proposal；
- `action_approval_requirements` 的 kind、state、policy version 与风险矩阵一致；
- `action_approvals` 只存在真实飞书 callback 产生的精确 actor 事实；
- `action_events` 与 proposal 版本变化一致且 append-only；
- `action_approval_presentations` 与其 append-only events 一致；
- `action_approval_presentation_outbox` 没有在途、结果未知或终态故障行；合法治理处置留下的 `failed/governance_disposition` 历史可保留；
- `action_executions` 对本轮 proposal 的计数为 `0`。

```sql
SELECT status, count(*) FROM action_proposals GROUP BY status ORDER BY status;
SELECT state, count(*) FROM action_approval_requirements GROUP BY state ORDER BY state;
SELECT state, count(*) FROM action_approval_presentations GROUP BY state ORDER BY state;
SELECT state, count(*) FROM action_approval_presentation_outbox GROUP BY state ORDER BY state;
SELECT count(*) AS terminal_failed FROM action_approval_presentation_outbox
WHERE state = 'failed'
  AND error_code IS DISTINCT FROM 'governance_disposition'
  AND error_code IS DISTINCT FROM 'presentation_superseded';
SELECT count(*) AS approval_count FROM action_approvals;
SELECT count(*) AS execution_count FROM action_executions;
```

飞书目标知识库中不得出现本轮测试标记对应的新节点或文档。数据库中不得存在本轮 execution，日志中不得出现 Wiki create/write 调用。

## 7. 退出与强制回滚

完成或任一失败时，按固定顺序回滚：

1. durable-disable global 和 pilot group，并设置 `generateKnowledgeDrafts=false`、`writeKnowledgeBase=false`。
2. 将 `.env.pilot` 恢复为 `IRIS_APPROVAL_ACTIONS_ENABLED=false`、空 action allowlist、`IRIS_KNOWLEDGE_CARD_ENABLED=false`、空 card allowlist。
3. 重建 Core；确认 action/card status 均显示安全关闭。
4. 等待 event/document/reindex/approval-interaction 的 pending/processing/delayed/DLQ 为 `0`。
5. 确认 action/card outbox 的 pending/processing/external_attempting/outcome_unknown/terminalFailed 为 `0`；保留 sent、合法治理处置和 append-only 历史。
6. 确认没有 `executing`、`reconciliation_required` 或本轮 `action_executions`。
7. 停止 Caddy，并从公网确认入口不可用。

只有第 5 节全部真实通过、第 6 节事实一致、第 7 节安全回滚完成，并把候选 SHA、CI、镜像 SHA、用例结果和最终零队列计数写入私有部署日志与 PR，Phase 5B-2A 才能标记为“真实灰度通过”。在此之前只能称为“代码实现完成，真实 pilot 待验收”。
