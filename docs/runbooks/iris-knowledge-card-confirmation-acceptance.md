# Iris Phase 5B-1 知识卡片群确认验收手册

> 范围仅限 Phase 5B-1：飞书群内的版本绑定卡片确认、要求修改和拒绝。本文不创建 `ActionProposal`，不提供 owner/admin approval 或 OAuth 审核页，也不写入飞书知识库。

## 操作边界和输入

- 真实 Feishu pilot 尚未通过；执行前需要批准、人工值守和失败即停止。
- 令牌、密码、`FEISHU_APP_SECRET`、`IRIS_INTERNAL_API_TOKEN` 和草稿正文不得进入命令行历史、日志、报告或 PR。
- 飞书卡片的原因输入上限必须保持 `1,000`；Core 服务端解析器保留 `2,000` 字符合同用于边界兼容，但不得向飞书发出 `max_length: 2000`。启用卡片前必须私下配置非空、最多 512 字符的 `FEISHU_ENCRYPT_KEY`，不得仅依赖 verification token。
- 已检查的部署日志与 runbook 没有保留可用真实群 ID；其中的 `oc_group_id` 是历史占位符，旧群已删除或其 ID 未被保留。不得猜测或复用它。
- 以下变量必须从当前机器人成员资格和 PostgreSQL 事实清单取得。三个已知群是负向控制；不能留空或用虚构 ID 代替。

```powershell
$PilotGroupId = $env:IRIS_PILOT_GROUP_ID
$KnownGroupIds = @($env:IRIS_KNOWN_GROUP_ID_1, $env:IRIS_KNOWN_GROUP_ID_2, $env:IRIS_KNOWN_GROUP_ID_3)
if ([string]::IsNullOrWhiteSpace($PilotGroupId) -or $KnownGroupIds.Count -ne 3 -or ($KnownGroupIds | Where-Object { [string]::IsNullOrWhiteSpace($_) }).Count -ne 0) { throw "Set IRIS_PILOT_GROUP_ID and exactly three IRIS_KNOWN_GROUP_ID_1..3 values from the current inventory" }
$PilotGroupId = $PilotGroupId.Trim()
$KnownGroupIds = @($KnownGroupIds | ForEach-Object { $_.Trim() })
if ((@($KnownGroupIds | Sort-Object -Unique)).Count -ne 3 -or $KnownGroupIds -contains $PilotGroupId) { throw "Known group IDs must be distinct and all distinct from the pilot group" }
$irisHeaders = @{ authorization = "Bearer $env:IRIS_INTERNAL_API_TOKEN"; "x-iris-operator" = "knowledge-card-pilot" }
$compose = @("compose", "--env-file", ".env.pilot", "--file", "deploy/pilot/docker-compose.yml")

function Assert-DurableMutation {
  param([object]$Result, [string]$Label)
  if ($null -eq $Result -or $Result.durable -ne $true) { throw "$Label did not return durable=true" }
  return $Result
}

function Get-PilotEnvValue {
  param([string]$Name)
  $matches = @(Get-Content -LiteralPath .env.pilot | Where-Object { $_ -match ("^{0}=(.*)$" -f [regex]::Escape($Name)) })
  if ($matches.Count -ne 1) { throw ".env.pilot must contain exactly one $Name assignment" }
  return ($matches[0] -replace ("^{0}=" -f [regex]::Escape($Name)), "")
}
```

## 本地退出门禁

在仓库根目录、未改变任何真实 rollout 配置前执行：

```powershell
npm run typecheck
npm run build
npm test
npm run test:python
npm run test:pilot
docker compose config
npm run readiness -- --env-file deploy/pilot/ci.env
npm run pilot:config
git diff --check
```

所有命令必须退出 `0`。`deploy/pilot/ci.env` 保持 `IRIS_KNOWLEDGE_CARD_ENABLED=false` 和空 `IRIS_KNOWLEDGE_CARD_GROUP_IDS`；默认-off `npm run pilot:smoke` 也要求此状态。此检查不会部署或开启真实 Feishu。

以下命令只解析本文的 PowerShell 围栏，不执行其中的服务操作；有任何语法错误即停止：

```powershell
$runbook = Get-Content -LiteralPath docs/runbooks/iris-knowledge-card-confirmation-acceptance.md -Raw
$blocks = [regex]::Matches($runbook, '(?ms)^```powershell\r?\n(.*?)^```$')
$allErrors = @()
foreach ($block in $blocks) {
  $tokens = $null
  $errors = $null
  [System.Management.Automation.Language.Parser]::ParseInput($block.Groups[1].Value, [ref]$tokens, [ref]$errors) | Out-Null
  $allErrors += $errors
}
if ($allErrors.Count -ne 0) { throw ($allErrors | ForEach-Object Message | Out-String) }
```

## 部署前 fail-closed 检查

1. 记录已批准提交 SHA。`IRIS_IMAGE_TAG`、运行中的 Core 镜像和 `APPROVED_COMMIT_SHA` 必须相同；不得使用移动标签。
2. 保持 Caddy stopped，确认 Core、Postgres、Redis、AI Worker 健康，且 `migrate` 以 `0` 退出。
3. 核对现有 event/document-sync/reindex 以及新的 approval-interaction pending/processing/delayed/DLQ 全部为 `0`；只读取计数，绝不打印队列 payload。

```powershell
$status = Invoke-RestMethod -Headers $irisHeaders -Uri http://localhost:3000/internal/status
if ($status.status -ne "healthy") { throw "Core internal status is not healthy" }
$existing = @([long]$status.components.eventWorker.pendingEventCount, [long]$status.components.eventWorker.deadLetterEventCount, [long]$status.components.documentSync.pendingJobCount, [long]$status.components.documentSync.deadLetterJobCount, [long]$status.components.reindex.pendingJobCount, [long]$status.components.reindex.deadLetterJobCount)
function Get-RedisCount {
  param([string]$RedisCommand, [string[]]$RedisArguments)
  $output = @(& docker @compose exec -T redis redis-cli $RedisCommand @RedisArguments)
  if ($LASTEXITCODE -ne 0) { throw "Redis $RedisCommand $($RedisArguments -join ' ') failed" }
  if ($output.Count -ne 1 -or $output[0].Trim() -notmatch '^\d+$') { throw "Redis $RedisCommand did not return one nonnegative integer" }
  return [long]$output[0].Trim()
}
$redisCounts = @(
  Get-RedisCount -RedisCommand LLEN -RedisArguments iris:events:raw:processing
  Get-RedisCount -RedisCommand LLEN -RedisArguments iris:documents:sync:processing
  Get-RedisCount -RedisCommand LLEN -RedisArguments iris:reindex:documents:processing
  Get-RedisCount -RedisCommand ZCARD -RedisArguments iris:approval:interactions:ready
  Get-RedisCount -RedisCommand ZCARD -RedisArguments iris:approval:interactions:processing
  Get-RedisCount -RedisCommand ZCARD -RedisArguments iris:approval:interactions:delayed
  Get-RedisCount -RedisCommand SCARD -RedisArguments iris:approval:interactions:dlq:members
)
if ((@($existing + $redisCounts | Where-Object { [long]$_ -ne 0 })).Count -ne 0) { throw "Queue or DLQ zero baseline failed; do not continue" }
```

4. Durably disable global Iris, all three known groups and the pilot group; set `generateKnowledgeDrafts=false` and `writeKnowledgeBase=false`; preserve `IRIS_KNOWLEDGE_CARD_ENABLED=false` with an empty `IRIS_KNOWLEDGE_CARD_GROUP_IDS` allowlist. Every mutation must return `durable=true`, then reread runtime state.

```powershell
$globalDisable = Assert-DurableMutation (Invoke-RestMethod -Method Post -Headers $irisHeaders -Uri http://localhost:3000/internal/runtime-control/global -ContentType "application/json" -Body '{"enabled":false}') "Global disable"
foreach ($groupId in $KnownGroupIds + $PilotGroupId) { $null = Assert-DurableMutation (Invoke-RestMethod -Method Post -Headers $irisHeaders -Uri "http://localhost:3000/internal/runtime-control/groups/$groupId" -ContentType "application/json" -Body '{"enabled":false}') "Group disable $groupId" }
$capabilityDisable = Assert-DurableMutation (Invoke-RestMethod -Method Patch -Headers $irisHeaders -Uri http://localhost:3000/internal/runtime-control/capabilities -ContentType "application/json" -Body '{"generateKnowledgeDrafts":false,"writeKnowledgeBase":false}') "Capability disable"
$runtime = Invoke-RestMethod -Headers $irisHeaders -Uri http://localhost:3000/internal/runtime-control/status
if ($runtime.persistence.ok -ne $true -or $runtime.globalEnabled -ne $false -or $runtime.desiredGlobalEnabled -ne $false -or $runtime.capabilities.generateKnowledgeDrafts -ne $false -or $runtime.capabilities.writeKnowledgeBase -ne $false) { throw "Runtime preflight is not durably disabled" }
$missingDisabledGroups = @($KnownGroupIds + $PilotGroupId | Where-Object { $runtime.disabledGroupIds -notcontains $_ })
if ($missingDisabledGroups.Count -ne 0) { throw "Runtime preflight did not disable every known and pilot group" }
```

## 单群开启和卡片 readiness

仅在前述检查通过后，私下将 `.env.pilot` 的 `IRIS_KNOWLEDGE_CARD_ENABLED=true` 和 `IRIS_KNOWLEDGE_CARD_GROUP_IDS` 设为唯一 `$PilotGroupId`。重建 Core 前执行以下不回显私有 env 文件的检查：

```powershell
if ((Get-PilotEnvValue IRIS_KNOWLEDGE_CARD_ENABLED) -cne "true") { throw "Knowledge cards are not explicitly enabled in .env.pilot" }
if ((Get-PilotEnvValue IRIS_KNOWLEDGE_CARD_GROUP_IDS) -cne $PilotGroupId) { throw "Knowledge-card allowlist is not exactly the pilot group" }
$encryptKey = Get-PilotEnvValue FEISHU_ENCRYPT_KEY
if ([string]::IsNullOrWhiteSpace($encryptKey) -or $encryptKey.Length -gt 512) { throw "FEISHU_ENCRYPT_KEY must be privately configured and bounded before enabling knowledge cards" }
```

重建后，`/internal/status` 的 `knowledgeCards` 只能包含 worker、queue、presentation 和 outbox 数字，不能含草稿正文、证据正文、`actorOpenId`、`reason` 或 token。outbox 至少必须包含 `pending`、`processing`、`external_attempting`、`failed`、`outcome_unknown`，并以 `terminalFailed` 区分会阻断 readiness 的 terminal/exhausted 失败；历史 `superseded` failed 计数本身不阻断。`/internal/approval-interactions/status` 必须在内部 bearer 路由可读，且 `pending`、`processing`、`delayed`、`deadLetter` 都为 `0`。pilot 基线还要求 outbox 的普通在途计数排空，且没有 unresolved outcome-unknown 或 terminal failed。随后只将 `$PilotGroupId` group runtime 设为 `true`，三个 `$KnownGroupIds` 保持 disabled；最后才开启 global runtime 和 Caddy。每次 mutation 都必须验证 durable 结果，并在开启后重新读取完整状态：

```powershell
$cardStatus = (Invoke-RestMethod -Headers $irisHeaders -Uri http://localhost:3000/internal/status).knowledgeCards
if ($null -eq $cardStatus -or $cardStatus.running -ne $true -or $cardStatus.dispatcher.running -ne $true -or $cardStatus.worker.running -ne $true) { throw "Knowledge-card runtime is not fully running" }
$requiredOutboxCounts = @("pending", "processing", "external_attempting", "sent", "failed", "outcome_unknown", "terminalFailed")
$outboxCounts = @{}
foreach ($name in $requiredOutboxCounts) {
  if ($cardStatus.outbox.PSObject.Properties.Name -notcontains $name) { throw "Knowledge-card outbox status is missing $name" }
  $count = 0L
  if (-not [long]::TryParse([string]$cardStatus.outbox.$name, [ref]$count) -or $count -lt 0) { throw "Knowledge-card outbox count $name is invalid" }
  $outboxCounts[$name] = $count
}
if ($outboxCounts.terminalFailed -gt $outboxCounts.failed) { throw "Knowledge-card terminal failed count exceeds failed count" }
$unresolvedOutbox = @($outboxCounts.pending, $outboxCounts.processing, $outboxCounts.external_attempting, $outboxCounts.outcome_unknown, $outboxCounts.terminalFailed)
if ((@($unresolvedOutbox | Where-Object { [long]$_ -ne 0 })).Count -ne 0) { throw "Knowledge-card outbox baseline is not drained or has unresolved failures" }
$cardReadiness = Invoke-RestMethod -Headers $irisHeaders -Uri http://localhost:3000/internal/readiness
$cardReadinessCheck = @($cardReadiness.checks | Where-Object { $_.id -eq "knowledgeCards" })
if ($cardReadiness.ok -ne $true -or $cardReadinessCheck.Count -ne 1 -or $cardReadinessCheck[0].status -ne "pass") { throw "Knowledge-card readiness is blocked" }
$pilotEnable = Assert-DurableMutation (Invoke-RestMethod -Method Post -Headers $irisHeaders -Uri "http://localhost:3000/internal/runtime-control/groups/$PilotGroupId" -ContentType "application/json" -Body '{"enabled":true}') "Pilot group enable"
$globalEnable = Assert-DurableMutation (Invoke-RestMethod -Method Post -Headers $irisHeaders -Uri http://localhost:3000/internal/runtime-control/global -ContentType "application/json" -Body '{"enabled":true}') "Global enable"
$enabledRuntime = Invoke-RestMethod -Headers $irisHeaders -Uri http://localhost:3000/internal/runtime-control/status
if ($enabledRuntime.persistence.ok -ne $true -or $enabledRuntime.globalEnabled -ne $true -or $enabledRuntime.desiredGlobalEnabled -ne $true) { throw "Global runtime enablement is not durable" }
if ($enabledRuntime.disabledGroupIds -contains $PilotGroupId) { throw "Pilot group is still disabled" }
if ((@($KnownGroupIds | Where-Object { $enabledRuntime.disabledGroupIds -notcontains $_ })).Count -ne 0) { throw "A negative-control group was enabled" }
if ((Get-PilotEnvValue IRIS_KNOWLEDGE_CARD_ENABLED) -cne "true" -or (Get-PilotEnvValue IRIS_KNOWLEDGE_CARD_GROUP_IDS) -cne $PilotGroupId) { throw "Knowledge-card allowlist no longer exactly matches the pilot group" }
```

从外部确认 `/health` 为 `200`，且 `POST /feishu/events` 与 `POST /feishu/card-actions` 都能到达 Core（不得为 `404`）；公开 `/internal/*`、`/feishu/card-actions/extra` 和其他未列出的路径必须为 `404`。AI Worker 不得公开端口，Caddy 只能代理上述两个精确回调路径，不能代理 `/internal/*` 或 Feishu 通配路径。

卡片回调明确返回“操作未提交，请稍后重试”时才允许稍后重新操作。若返回“提交状态未确认，请勿重复点击；请以卡片最终状态为准”，不得再次点击；等待原单次幂等入队完成并以卡片最终状态、approval-interaction 队列计数和 Postgres 事实核对结果。超时路径不得自动发起第二次入队。

## 真实 Feishu 六例

每例使用测试草稿，等待 worker 清空，并将可见卡片结果与 Postgres 事实双向核对：

1. 完整内容确认：操作前可见卡片必须显示 `Iris / pending_confirmation`、来源类型、草稿 ID、修订号和草稿版本，且不显示来源消息/证据原文；当前 `pending_confirmation` 草稿确认后最终卡片必须显示 `Iris / confirmed`、相同绑定元数据、已提交 actor/time 和 `Next gate: pending_review`。只新增一次 group confirmation 和对应 append-only event，草稿进入 `pending_review`。
2. 要求修改：另一个当前草稿提交非空原因；最终卡片必须显示 `Iris / revision_requested`、相同绑定元数据、`needs_revision` 和数据库已提交的规范化原因，不得回显未提交 callback 字段；草稿状态和 event 与可见原因一致。
3. 拒绝：第三个草稿在飞书确认拒绝；最终卡片必须显示 `Iris / rejected`、相同绑定元数据、`rejected` 和数据库已提交的规范化原因；草稿为终态 rejected，后续点击不改变业务事实。
4. 过期卡片：生成新修订或使证据失效后点击旧卡；必须 stale/不可处理，且不新增 confirmation、event 或状态变化。
5. 重复 callback 重放：同一 callback event 只产生一次业务结果和一次对应事实。
6. 运行时停用后点击：先 durable-disable `$PilotGroupId` 再点击旧卡；不得产生业务状态变化。

每例只查询 `knowledge_draft_presentations`、`knowledge_draft_presentation_events`、`knowledge_draft_group_confirmations` 和 `knowledge_draft_events` 的 ID、状态、版本、action、时间和计数；不得选择草稿或证据正文。可见 Feishu 结果必须与 presentation/draft/revision/event/confirmation 事实一致。

## 非 pilot 负向控制、回滚和边界

在三个 `$KnownGroupIds` 中各发送普通消息并执行旧卡片/回调负向检查；不得产生 presentation、approval interaction、confirmation 或 draft event。不得通过删除 Redis 或数据库记录伪造通过。

完成或任一失败时按顺序回滚：先将私有 `.env.pilot` 还原为 `IRIS_KNOWLEDGE_CARD_ENABLED=false` 和空 `IRIS_KNOWLEDGE_CARD_GROUP_IDS`，再 durable-disable pilot/三个已知群/global/`generateKnowledgeDrafts` 并保持 `writeKnowledgeBase=false`，然后重建 Core，确认卡片 status route fail-closed、所有队列和 DLQ 为零，最后停止 Caddy。保留 append-only 事实；迁移只向前，不删除 presentation、confirmation 或 event 历史。

本文不允许、也不声称存在知识库发布。飞书知识库写入属于 Phase 5B-3，必须在独立计划、门禁和真实验收后才可执行。
