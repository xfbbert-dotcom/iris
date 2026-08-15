# Iris Knowledge-Conflict Candidate Acceptance And Rollback

Status: pending live acceptance. This runbook is the only release gate for the first one-group
knowledge-conflict pilot. It creates a governed update draft and does not edit the existing Wiki page in place.
Run it from the repository root with a clean reviewed checkout and a private
`.env.pilot`. Never paste source text, prompts, credentials, or callback payloads into the evidence
record.

The controller below remains attached for the entire pilot. Every exit, including a successful
acceptance, enters the same fail-closed rollback. Do not run the enablement commands piecemeal.

## Step 1: Pin The Reviewed SHA And Image Digest

Set `APPROVED_COMMIT_SHA` to one lowercase 40-character commit and
`IRIS_APPROVED_IMAGE_DIGEST` to the inspected `sha256:` image ID. The checkout must be clean,
`IRIS_IMAGE_TAG` must equal the SHA, and the running image must match the digest. Moving tags are
not accepted.

## Step 2: Inventory One Pilot And Nonpilot Controls

Export the current bot group membership as one group ID per line and set
`IRIS_BOT_GROUP_INVENTORY_PATH`. Set `IRIS_PILOT_GROUP_ID` to exactly one current group and
`IRIS_KNOWLEDGE_CONFLICT_CONTROL_GROUP_IDS` to one or more distinct current nonpilot groups.
The controller unions that live inventory with every historical group found in PostgreSQL and
durably disables the complete nonpilot set.

## Step 3: Prove The Disabled Empty Baseline

Before fixture creation, the controller stops Caddy, requires the conflict flag off and allowlist
empty, disables global/group runtime and write-related capabilities, checks current readiness, and
records content-free queue/outbox and append-only fact counts. Pending/retry/processing work, DLQs,
outcome-unknown deliveries, and terminal failures must all be zero.

## Step 4: Establish Controlled Chronology

While the feature is still off, create or select one controlled authorized Wiki source and current
snapshot. In the pilot group, reach a normal incompatible conclusion strictly after the snapshot's
`fetched_at`. Put only IDs, versions, hashes, and timestamps into the private evidence JSON. The
controller proves the message time is later than the snapshot time; it never reads or emits either
statement.

## Step 5: Enable Only The Pilot Privately

The controller marks enablement attempted before changing `.env.pilot`, keeps Caddy stopped,
enables the conflict/card/approval allowlists for exactly the pilot, recreates Core, enables only
the required read/draft/proactive capabilities, enables the pilot and global runtime durably, then
requires status and readiness to pass before starting Caddy. `writeKnowledgeBase` stays false.

## Step 6: Prove One Exact Scan And Candidate

After one eligible memory is produced, record the scan, memory, candidate, document source,
snapshot, source version, and content hash identities. The controller requires exactly one scan and
one candidate for that binding and exact conversation-message, memory, source, and snapshot
evidence rows.

## Step 7: Prove The Ordinary Answer Shows Both Sides

Ask an ordinary question about the controlled subject. Record the answer delivery ID and observed
pass/fail facts. The answer must expose the synchronized knowledge side and the newer group side,
label the conflict, and contain no invented winner or resolution. PostgreSQL must bind the answer
delivery to the exact candidate.

## Step 8: Approve Exactly One Delivery

Before operator approval, record that no conflict card was sent. The controller approves the exact
candidate version once with a stable operation key, then requires exactly one delivery row. Record
the resulting delivery/message IDs and card observation; never record rendered card text.

## Step 9: Exercise Callback And Negative Controls

Using the same live window, exercise: current-member draft creation; duplicate delivery and exact
callback replay; a no-conflict memory; a related-subject memory; nonmember denial; permission
revocation; and snapshot replacement before action. The evidence JSON records only involved IDs
and one pass/fail flag per check. No duplicate message or draft is allowed, unrelated evidence must
not substitute, and revocation must prevent disclosure or creation.

## Step 10: Prove The Governed Draft And Drain

Require exactly one `knowledge_conflict` draft at `medium` risk, in the existing confirmation,
review, and publication path. This is a governed update draft and does not edit the existing Wiki
page in place. All conflict queues/outboxes must drain, no unknown or terminal failure may remain,
and every nonpilot group must retain its Step 3 fact counts.

## Step 11: Disable Unless A Separate Daily Decision Exists

This runbook always disables at exit. A later daily-pilot decision requires a separately reviewed
record and a new invocation; it is not an option in this acceptance controller. Rollback order is:
stop Caddy; restore the conflict/card/approval flags and allowlists to off/empty; durable-disable all
known groups, global runtime, and read/draft/proactive/write capabilities; recreate Core; prove no
new scan/outbox activity; and retain all append-only PostgreSQL facts.

## Step 12: Record Metadata-Only Evidence

The evidence artifact may contain only IDs, versions, hashes, counts, timestamps, exact image
digest, and observed pass/fail facts. It must not contain source statements, messages, document
text, prompts, rendered cards, secrets, or authorization material. The controller writes a bounded
JSON summary next to the private evidence input and identifies the failed step if acceptance fails.

## Executable Controller

The private evidence file is updated between prompts. Its required shape is documented after the
controller. Type `PASS` only after the named live observation has been completed and the metadata
file updated.

```powershell
$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$ApprovedCommitSha = $env:APPROVED_COMMIT_SHA
$ApprovedImageDigest = $env:IRIS_APPROVED_IMAGE_DIGEST
$PilotGroupId = $env:IRIS_PILOT_GROUP_ID
$ControlGroupIds = @($env:IRIS_KNOWLEDGE_CONFLICT_CONTROL_GROUP_IDS -split ',' | ForEach-Object { $_.Trim() } | Where-Object { $_ -ne "" } | Sort-Object -Unique)
$BotGroupInventoryPath = $env:IRIS_BOT_GROUP_INVENTORY_PATH
$EvidencePath = $env:IRIS_KNOWLEDGE_CONFLICT_EVIDENCE_PATH
$PilotEnvPath = ".env.pilot"
$compose = @("compose", "--env-file", $PilotEnvPath, "--file", "deploy/pilot/docker-compose.yml")
$irisHeaders = @{ authorization = "Bearer $env:IRIS_INTERNAL_API_TOKEN"; "x-iris-operator" = "knowledge-conflict-pilot" }
$script:EnableAttempted = $false
$script:FailedStep = 0
$script:KnownGroupIds = @()
$script:BaselineActivity = $null
$script:BaselineAppendOnlyFacts = $null
$script:BaselineGroupFacts = @{}
$script:RollbackErrors = @()

function Assert-Reference {
  param([Parameter(Mandatory)][string]$Name, [Parameter(Mandatory)][string]$Value)
  if ($Value -cnotmatch '^[A-Za-z0-9:_-]{1,512}$') { throw "$Name is missing or unsafe" }
  return $Value
}

function Get-PilotEnvValue {
  param([Parameter(Mandatory)][string]$Name)
  $matches = @(Get-Content -LiteralPath $PilotEnvPath | Where-Object { $_ -match ("^{0}=(.*)$" -f [regex]::Escape($Name)) })
  if ($matches.Count -ne 1) { throw "$PilotEnvPath must contain exactly one $Name assignment" }
  return ($matches[0] -replace ("^{0}=" -f [regex]::Escape($Name)), "")
}

function Set-PilotEnvValue {
  param([Parameter(Mandatory)][string]$Name, [AllowEmptyString()][string]$Value)
  $lines = @(Get-Content -LiteralPath $PilotEnvPath)
  $indexes = @(0..($lines.Count - 1) | Where-Object { $lines[$_] -match ("^{0}=" -f [regex]::Escape($Name)) })
  if ($indexes.Count -ne 1) { throw "$PilotEnvPath must contain exactly one $Name assignment" }
  $lines[$indexes[0]] = "$Name=$Value"
  Set-Content -LiteralPath $PilotEnvPath -Value $lines -Encoding utf8
}

function Get-PilotEnv {
  $entries = Get-Content -LiteralPath $PilotEnvPath | Where-Object { $_ -match '^[A-Za-z_][A-Za-z0-9_]*=' }
  return ConvertFrom-StringData ($entries -join "`n")
}

function Invoke-PilotSql {
  param([Parameter(Mandatory)][string]$Sql)
  $pilotEnv = Get-PilotEnv
  $result = @(& docker @compose exec -T postgres psql -v ON_ERROR_STOP=1 -U $pilotEnv.POSTGRES_USER -d $pilotEnv.POSTGRES_DB -Atc $Sql)
  if ($LASTEXITCODE -ne 0) { throw "PostgreSQL metadata query failed" }
  return $result
}

function Invoke-JsonSql {
  param([Parameter(Mandatory)][string]$Sql)
  $lines = @(Invoke-PilotSql -Sql $Sql)
  if ($lines.Count -ne 1) { throw "PostgreSQL metadata query did not return one row" }
  return ($lines[0] | ConvertFrom-Json)
}

function Assert-DurableMutation {
  param([Parameter(Mandatory)][object]$Result, [Parameter(Mandatory)][string]$Label)
  if ($Result.durable -ne $true) { throw "$Label did not return durable=true" }
}

function Confirm-ObservedPass {
  param([Parameter(Mandatory)][string]$Label)
  if ((Read-Host "$Label; type PASS").Trim() -cne "PASS") { throw "$Label was not confirmed" }
}

function Get-Evidence {
  if (-not (Test-Path -LiteralPath $EvidencePath)) { throw "Private metadata evidence file is unavailable" }
  return (Get-Content -LiteralPath $EvidencePath -Raw | ConvertFrom-Json)
}

function Get-KnowledgeConflictActivityCounts {
  return Invoke-JsonSql -Sql @"
SELECT json_build_object(
  'scanActive', count(*) FILTER (WHERE status IN ('pending','processing','retry')),
  'scanDeadLettered', count(*) FILTER (WHERE status = 'dead_lettered'),
  'deliveryActive', (SELECT count(*) FROM knowledge_conflict_delivery_outbox WHERE status IN ('pending','processing','external_attempting','failed','outcome_unknown')),
  'deliveryOutcomeUnknown', (SELECT count(*) FROM knowledge_conflict_delivery_outbox WHERE status = 'outcome_unknown'),
  'deliveryTerminalFailed', (SELECT count(*) FROM knowledge_conflict_delivery_outbox WHERE status = 'failed' AND retryable = FALSE)
) FROM knowledge_conflict_scan_inbox;
"@
}

function Get-AppendOnlyFactCounts {
  return Invoke-JsonSql -Sql @"
SELECT json_build_object(
  'scanOperations', (SELECT count(*) FROM knowledge_conflict_scan_operations),
  'evidence', (SELECT count(*) FROM knowledge_conflict_evidence),
  'candidateEvents', (SELECT count(*) FROM knowledge_conflict_candidate_events),
  'deliveryReconciliations', (SELECT count(*) FROM knowledge_conflict_delivery_reconciliations),
  'interactions', (SELECT count(*) FROM knowledge_conflict_interactions),
  'answerBindings', (SELECT count(*) FROM answer_reply_knowledge_conflicts),
  'callbackIdentities', (SELECT count(*) FROM knowledge_conflict_callback_identities),
  'draftAttestations', (SELECT count(*) FROM knowledge_conflict_draft_governance_attestations),
  'draftEvents', (SELECT count(*) FROM knowledge_draft_events)
);
"@
}

function Get-GroupFactCounts {
  param([Parameter(Mandatory)][string]$GroupId)
  $safeGroupId = Assert-Reference -Name "group ID" -Value $GroupId
  return Invoke-JsonSql -Sql @"
SELECT json_build_object(
  'scans', (SELECT count(*) FROM knowledge_conflict_scan_inbox WHERE group_id = '$safeGroupId'),
  'candidates', (SELECT count(*) FROM knowledge_conflict_candidates WHERE group_id = '$safeGroupId'),
  'deliveries', (SELECT count(*) FROM knowledge_conflict_delivery_outbox WHERE group_id = '$safeGroupId'),
  'drafts', (SELECT count(*) FROM knowledge_drafts WHERE source_group_id = '$safeGroupId' AND origin_kind = 'knowledge_conflict')
);
"@
}

function Assert-CountsUnchanged {
  param([Parameter(Mandatory)][object]$Before, [Parameter(Mandatory)][object]$After, [Parameter(Mandatory)][string]$Label)
  foreach ($property in $Before.PSObject.Properties.Name) {
    if ([long]$Before.$property -ne [long]$After.$property) { throw "$Label changed at $property" }
  }
}

function Assert-AppendOnlyFactsPreserved {
  param([Parameter(Mandatory)][object]$Before, [Parameter(Mandatory)][object]$After)
  foreach ($property in $Before.PSObject.Properties.Name) {
    if ([long]$After.$property -lt [long]$Before.$property) { throw "Append-only PostgreSQL facts decreased at $property" }
  }
}

function Assert-DrainedActivity {
  param([Parameter(Mandatory)][object]$Counts)
  foreach ($name in @('scanActive','scanDeadLettered','deliveryActive','deliveryOutcomeUnknown','deliveryTerminalFailed')) {
    if ([long]$Counts.$name -ne 0) { throw "Knowledge-conflict durable activity is not drained at $name" }
  }
}

function Assert-CoreQueuesDrained {
  param([Parameter(Mandatory)][object]$Status)
  $counts = @(
    $Status.components.eventWorker.pendingEventCount,
    $Status.components.eventWorker.deadLetterEventCount,
    $Status.components.documentSync.pendingJobCount,
    $Status.components.documentSync.deadLetterJobCount,
    $Status.components.reindex.pendingJobCount,
    $Status.components.reindex.deadLetterJobCount
  )
  if ($Status.PSObject.Properties.Name -contains 'knowledgeCards') {
    $counts += @($Status.knowledgeCards.queue.pending, $Status.knowledgeCards.queue.processing, $Status.knowledgeCards.queue.delayed, $Status.knowledgeCards.queue.deadLetter, $Status.knowledgeCards.outbox.pending, $Status.knowledgeCards.outbox.processing, $Status.knowledgeCards.outbox.external_attempting, $Status.knowledgeCards.outbox.outcome_unknown, $Status.knowledgeCards.outbox.terminalFailed)
  }
  if ($Status.components.actionApprovals.enabled -eq $true) {
    $counts += @($Status.components.actionApprovals.outbox.pending, $Status.components.actionApprovals.outbox.processing, $Status.components.actionApprovals.outbox.external_attempting, $Status.components.actionApprovals.outbox.outcome_unknown, $Status.components.actionApprovals.outbox.terminalFailed)
  }
  if ((@($counts | Where-Object { [long]$_ -ne 0 })).Count -ne 0) { throw "A required queue, DLQ, or outbox is not drained" }
}

function Invoke-RollbackStep {
  param([Parameter(Mandatory)][scriptblock]$Action, [Parameter(Mandatory)][string]$Label)
  try { & $Action } catch { $script:RollbackErrors += "$Label failed" }
}

function Invoke-KnowledgeConflictRollback {
  Invoke-RollbackStep -Label "stop caddy" -Action { & docker @compose stop caddy; if ($LASTEXITCODE -ne 0) { throw "stop caddy failed" } }
  Invoke-RollbackStep -Label "disable conflict env" -Action {
    Set-PilotEnvValue IRIS_KNOWLEDGE_CONFLICT_ENABLED "false"
    Set-PilotEnvValue IRIS_KNOWLEDGE_CONFLICT_GROUP_ALLOWLIST ""
    Set-PilotEnvValue IRIS_KNOWLEDGE_CARD_ENABLED "false"
    Set-PilotEnvValue IRIS_KNOWLEDGE_CARD_GROUP_IDS ""
    Set-PilotEnvValue IRIS_APPROVAL_ACTIONS_ENABLED "false"
    Set-PilotEnvValue IRIS_APPROVAL_ACTION_GROUP_IDS ""
    if ((Get-PilotEnvValue IRIS_KNOWLEDGE_CONFLICT_ENABLED) -cne "false") { throw "IRIS_KNOWLEDGE_CONFLICT_ENABLED=false was not persisted" }
    if ((Get-PilotEnvValue IRIS_KNOWLEDGE_CONFLICT_GROUP_ALLOWLIST) -cne "") { throw "IRIS_KNOWLEDGE_CONFLICT_GROUP_ALLOWLIST= was not persisted" }
  }
  foreach ($groupId in $script:KnownGroupIds) {
    Invoke-RollbackStep -Label "group disable" -Action {
      $result = Invoke-RestMethod -Method Post -Headers $irisHeaders -Uri "http://localhost:3000/internal/runtime-control/groups/$groupId" -ContentType "application/json" -Body '{"enabled":false}'
      Assert-DurableMutation $result "Group disable"
    }
  }
  Invoke-RollbackStep -Label "global disable" -Action {
    $result = Invoke-RestMethod -Method Post -Headers $irisHeaders -Uri http://localhost:3000/internal/runtime-control/global -ContentType "application/json" -Body '{"enabled":false}'
    Assert-DurableMutation $result "Global disable"
  }
  Invoke-RollbackStep -Label "capability disable" -Action {
    $result = Invoke-RestMethod -Method Patch -Headers $irisHeaders -Uri http://localhost:3000/internal/runtime-control/capabilities -ContentType "application/json" -Body '{"readGroupDocuments":false,"retrieveKnowledgeBase":false,"proactiveSpeech":false,"generateKnowledgeDrafts":false,"writeKnowledgeBase":false}'
    Assert-DurableMutation $result "Capability disable"
  }
  Invoke-RollbackStep -Label "Core recreate" -Action {
    & docker @compose up --detach --force-recreate --wait --wait-timeout 120 core
    if ($LASTEXITCODE -ne 0) { throw "Core rollback recreate failed" }
  }
  Invoke-RollbackStep -Label "rollback quiescence" -Action {
    $activityBeforeWait = Get-KnowledgeConflictActivityCounts
    $factsBeforeWait = Get-AppendOnlyFactCounts
    Start-Sleep -Seconds 5
    $activityAfterWait = Get-KnowledgeConflictActivityCounts
    Assert-CountsUnchanged -Before $activityBeforeWait -After $activityAfterWait -Label "Disabled scan/outbox activity"
    $factsAfterRollback = Get-AppendOnlyFactCounts
    Assert-CountsUnchanged -Before $factsBeforeWait -After $factsAfterRollback -Label "Disabled append-only activity"
    Assert-AppendOnlyFactsPreserved -Before $script:BaselineAppendOnlyFacts -After $factsAfterRollback
    $runtime = Invoke-RestMethod -Headers $irisHeaders -Uri http://localhost:3000/internal/runtime-control/status
    if ($runtime.globalEnabled -ne $false -or $runtime.desiredGlobalEnabled -ne $false) { throw "Rollback runtime is not disabled" }
    $status = Invoke-RestMethod -Headers $irisHeaders -Uri http://localhost:3000/internal/status
    if ($status.components.knowledgeConflicts.enabled -ne $false) { throw "Rollback conflict runtime is still enabled" }
  }
}

function Invoke-KnowledgeConflictAcceptance {
  $script:FailedStep = 1
  if ($ApprovedCommitSha -cnotmatch '^[0-9a-f]{40}$') { throw "APPROVED_COMMIT_SHA is invalid" }
  if ($ApprovedImageDigest -cnotmatch '^sha256:[0-9a-f]{64}$') { throw "IRIS_APPROVED_IMAGE_DIGEST is invalid" }
  if ((git status --porcelain --untracked-files=all).Count -ne 0) { throw "Reviewed checkout is not clean" }
  if ((git rev-parse HEAD).Trim() -cne $ApprovedCommitSha) { throw "Local SHA differs from approved SHA" }
  if ((Get-PilotEnvValue IRIS_IMAGE_TAG) -cne $ApprovedCommitSha) { throw "IRIS_IMAGE_TAG is not the exact approved SHA" }
  $imageId = (& docker image inspect "iris-core:$ApprovedCommitSha" --format '{{.Id}}').Trim()
  if ($LASTEXITCODE -ne 0 -or $imageId -cne $ApprovedImageDigest) { throw "Core image digest differs from the approved digest" }

  $script:FailedStep = 2
  $pilot = Assert-Reference -Name "pilot group" -Value $PilotGroupId
  if (-not (Test-Path -LiteralPath $BotGroupInventoryPath)) { throw "Current bot group inventory is unavailable" }
  $currentBotGroupIds = @(Get-Content -LiteralPath $BotGroupInventoryPath | ForEach-Object { $_.Trim() } | Where-Object { $_ -ne "" } | ForEach-Object { Assert-Reference -Name "inventory group" -Value $_ } | Sort-Object -Unique)
  if ($currentBotGroupIds -notcontains $pilot -or $ControlGroupIds.Count -lt 1) { throw "Pilot or nonpilot control inventory is incomplete" }
  foreach ($control in $ControlGroupIds) {
    $null = Assert-Reference -Name "control group" -Value $control
    if ($control -eq $pilot -or $currentBotGroupIds -notcontains $control) { throw "Control group is not a current distinct nonpilot group" }
  }
  $databaseGroupIds = @(Invoke-PilotSql -Sql "SELECT group_id FROM (SELECT chat_id AS group_id FROM conversation_messages UNION SELECT group_id FROM group_memories UNION SELECT group_id FROM knowledge_conflict_candidates) groups WHERE group_id IS NOT NULL AND group_id <> '' ORDER BY group_id;" | ForEach-Object { Assert-Reference -Name "database group" -Value $_.Trim() })
  $script:KnownGroupIds = @($currentBotGroupIds + $databaseGroupIds | Sort-Object -Unique)
  $nonPilotGroupIds = @($script:KnownGroupIds | Where-Object { $_ -ne $pilot })

  $script:FailedStep = 3
  & docker @compose stop caddy
  if ($LASTEXITCODE -ne 0) { throw "Caddy preflight stop failed" }
  if ((Get-PilotEnvValue IRIS_KNOWLEDGE_CONFLICT_ENABLED) -cne "false" -or (Get-PilotEnvValue IRIS_KNOWLEDGE_CONFLICT_GROUP_ALLOWLIST) -cne "") { throw "Conflict defaults are not off/empty" }
  foreach ($groupId in $script:KnownGroupIds) {
    Assert-DurableMutation (Invoke-RestMethod -Method Post -Headers $irisHeaders -Uri "http://localhost:3000/internal/runtime-control/groups/$groupId" -ContentType "application/json" -Body '{"enabled":false}') "Preflight group disable"
  }
  Assert-DurableMutation (Invoke-RestMethod -Method Post -Headers $irisHeaders -Uri http://localhost:3000/internal/runtime-control/global -ContentType "application/json" -Body '{"enabled":false}') "Preflight global disable"
  Assert-DurableMutation (Invoke-RestMethod -Method Patch -Headers $irisHeaders -Uri http://localhost:3000/internal/runtime-control/capabilities -ContentType "application/json" -Body '{"readGroupDocuments":false,"retrieveKnowledgeBase":false,"proactiveSpeech":false,"generateKnowledgeDrafts":false,"writeKnowledgeBase":false}') "Preflight capability disable"
  $readiness = Invoke-RestMethod -Headers $irisHeaders -Uri http://localhost:3000/internal/readiness
  $disabledStatus = Invoke-RestMethod -Headers $irisHeaders -Uri http://localhost:3000/internal/status
  $conflictCheck = @($readiness.checks | Where-Object { $_.id -eq 'knowledgeConflicts' })
  if ($readiness.ok -ne $true -or $disabledStatus.status -cne 'healthy' -or $conflictCheck.Count -ne 1 -or $conflictCheck[0].detail -cne 'Knowledge conflicts are safely disabled.') { throw "Disabled readiness failed" }
  Assert-CoreQueuesDrained $disabledStatus
  $script:BaselineActivity = Get-KnowledgeConflictActivityCounts
  Assert-DrainedActivity $script:BaselineActivity
  $script:BaselineAppendOnlyFacts = Get-AppendOnlyFactCounts
  foreach ($groupId in $nonPilotGroupIds) { $script:BaselineGroupFacts[$groupId] = Get-GroupFactCounts $groupId }

  $script:FailedStep = 4
  Confirm-ObservedPass "Create the controlled authorized Wiki snapshot and strictly later incompatible pilot conclusion"
  $fixture = Get-Evidence
  foreach ($field in @('documentSourceId','snapshotId','contentHash','sourceVersion','groupMessageId','memoryId')) {
    $null = Assert-Reference -Name $field -Value ([string]$fixture.$field)
  }
  if ([string]$fixture.contentHash -cnotmatch '^[0-9a-f]{64}$') { throw "Fixture content hash is invalid" }
  $chronology = Invoke-JsonSql -Sql "SELECT json_build_object('ordered', message.sent_at > snapshot.fetched_at) FROM conversation_messages message JOIN document_snapshots snapshot ON snapshot.id = '$($fixture.snapshotId)' AND snapshot.document_source_id = '$($fixture.documentSourceId)' WHERE message.id = '$($fixture.groupMessageId)' AND message.chat_id = '$pilot';"
  if ($chronology.ordered -ne $true) { throw "Group evidence is not strictly later than the knowledge snapshot" }

  $script:FailedStep = 5
  $EnableAttempted = $true
  $script:EnableAttempted = $EnableAttempted
  Set-PilotEnvValue IRIS_KNOWLEDGE_CONFLICT_ENABLED "true"
  Set-PilotEnvValue IRIS_KNOWLEDGE_CONFLICT_GROUP_ALLOWLIST $pilot
  Set-PilotEnvValue IRIS_KNOWLEDGE_CARD_ENABLED "true"
  Set-PilotEnvValue IRIS_KNOWLEDGE_CARD_GROUP_IDS $pilot
  Set-PilotEnvValue IRIS_APPROVAL_ACTIONS_ENABLED "true"
  Set-PilotEnvValue IRIS_APPROVAL_ACTION_GROUP_IDS $pilot
  & docker @compose up --detach --force-recreate --wait --wait-timeout 120 core
  if ($LASTEXITCODE -ne 0) { throw "Enabled Core recreate failed" }
  Assert-DurableMutation (Invoke-RestMethod -Method Patch -Headers $irisHeaders -Uri http://localhost:3000/internal/runtime-control/capabilities -ContentType "application/json" -Body '{"readGroupDocuments":true,"retrieveKnowledgeBase":true,"proactiveSpeech":true,"generateKnowledgeDrafts":true,"writeKnowledgeBase":false}') "Pilot capability enable"
  Assert-DurableMutation (Invoke-RestMethod -Method Post -Headers $irisHeaders -Uri "http://localhost:3000/internal/runtime-control/groups/$pilot" -ContentType "application/json" -Body '{"enabled":true}') "Pilot group enable"
  Assert-DurableMutation (Invoke-RestMethod -Method Post -Headers $irisHeaders -Uri http://localhost:3000/internal/runtime-control/global -ContentType "application/json" -Body '{"enabled":true}') "Pilot global enable"
  $enabledReadiness = Invoke-RestMethod -Headers $irisHeaders -Uri http://localhost:3000/internal/readiness
  $enabledStatus = Invoke-RestMethod -Headers $irisHeaders -Uri http://localhost:3000/internal/status
  $enabledRuntime = Invoke-RestMethod -Headers $irisHeaders -Uri http://localhost:3000/internal/runtime-control/status
  if ($enabledReadiness.ok -ne $true -or $enabledStatus.components.knowledgeConflicts.running -ne $true -or $enabledRuntime.globalEnabled -ne $true -or $enabledRuntime.desiredGlobalEnabled -ne $true) { throw "Enabled conflict runtime is not ready" }
  if ($enabledRuntime.disabledGroupIds -contains $pilot -or (@($nonPilotGroupIds | Where-Object { $enabledRuntime.disabledGroupIds -notcontains $_ })).Count -ne 0) { throw "Pilot/nonpilot runtime isolation failed" }
  if ((Get-PilotEnvValue IRIS_KNOWLEDGE_CONFLICT_ENABLED) -cne 'true' -or (Get-PilotEnvValue IRIS_KNOWLEDGE_CONFLICT_GROUP_ALLOWLIST) -cne $pilot) { throw "Pilot conflict allowlist is not exact" }
  & docker @compose up --detach --wait --wait-timeout 120 caddy
  if ($LASTEXITCODE -ne 0) { throw "Caddy start failed" }

  $script:FailedStep = 6
  Confirm-ObservedPass "Wait for exactly one scan and candidate, then update the metadata evidence file"
  $evidence = Get-Evidence
  foreach ($field in @('scanId','candidateId','memoryId','documentSourceId','snapshotId','contentHash','sourceVersion')) { $null = Assert-Reference -Name $field -Value ([string]$evidence.$field) }
  $binding = Invoke-JsonSql -Sql "SELECT json_build_object('scanCount',(SELECT count(*) FROM knowledge_conflict_scan_inbox WHERE id='$($evidence.scanId)' AND group_id='$pilot' AND group_memory_id='$($evidence.memoryId)' AND terminal_outcome='conflict'),'candidateCount',(SELECT count(*) FROM knowledge_conflict_candidates WHERE id='$($evidence.candidateId)' AND group_id='$pilot' AND group_memory_id='$($evidence.memoryId)' AND target_document_source_id='$($evidence.documentSourceId)' AND target_snapshot_id='$($evidence.snapshotId)' AND target_content_hash='$($evidence.contentHash)' AND target_source_version='$($evidence.sourceVersion)'),'evidenceKinds',(SELECT count(DISTINCT evidence_type) FROM knowledge_conflict_evidence WHERE candidate_id='$($evidence.candidateId)'));"
  if ([long]$binding.scanCount -ne 1 -or [long]$binding.candidateCount -ne 1 -or [long]$binding.evidenceKinds -ne 5) { throw "Exact scan/candidate evidence binding failed" }

  $script:FailedStep = 7
  Confirm-ObservedPass "Ask the ordinary question; verify both sides and no resolution; update pass/fail metadata"
  $evidence = Get-Evidence
  if ($evidence.observed.answerBothSides -ne $true -or $evidence.observed.answerNoResolution -ne $true) { throw "Ordinary answer observation failed" }
  $answerBinding = @(Invoke-PilotSql -Sql "SELECT delivery_id FROM answer_reply_knowledge_conflicts WHERE delivery_id='$($evidence.answerDeliveryId)' AND candidate_id='$($evidence.candidateId)';")
  if ($answerBinding.Count -ne 1) { throw "Answer is not bound to the exact conflict candidate" }

  $script:FailedStep = 8
  if ($evidence.observed.noCardBeforeApproval -ne $true) { throw "Pre-approval no-card observation failed" }
  $candidate = Invoke-JsonSql -Sql "SELECT json_build_object('version',version,'deliveryCount',(SELECT count(*) FROM knowledge_conflict_delivery_outbox WHERE candidate_id='$($evidence.candidateId)')) FROM knowledge_conflict_candidates WHERE id='$($evidence.candidateId)' AND group_id='$pilot';"
  if ([long]$candidate.deliveryCount -ne 0) { throw "A delivery exists before operator approval" }
  $approvalBody = @{ expectedVersion = [long]$candidate.version; reason = "Reviewed for one bounded pilot delivery."; operationKey = "pilot:$($evidence.candidateId):approve:$($candidate.version)" } | ConvertTo-Json -Compress
  $approval = Invoke-RestMethod -Method Post -Headers $irisHeaders -Uri "http://localhost:3000/internal/knowledge-conflicts/groups/$pilot/candidates/$($evidence.candidateId)/approve-delivery" -ContentType "application/json" -Body $approvalBody
  if ($approval.ok -ne $true -or $approval.outcome -notin @('applied','already_applied')) { throw "Exact candidate approval failed" }
  Confirm-ObservedPass "Observe exactly one approved conflict card and update delivery metadata"
  $evidence = Get-Evidence
  $deliveryCount = @(Invoke-PilotSql -Sql "SELECT id FROM knowledge_conflict_delivery_outbox WHERE candidate_id='$($evidence.candidateId)' AND group_id='$pilot';")
  if ($deliveryCount.Count -ne 1 -or $evidence.observed.oneApprovedCard -ne $true) { throw "Exactly one approved delivery was not proven" }

  $script:FailedStep = 9
  Confirm-ObservedPass "Exercise member draft, duplicate delivery/callback, controls, nonmember denial, and permission/snapshot revocation"
  $evidence = Get-Evidence
  foreach ($name in @('duplicateDeliveryNoEffect','duplicateCallbackNoEffect','noConflictControl','relatedSubjectControl','nonmemberDenied','permissionRevocationBlocked','snapshotRevocationBlocked')) {
    if ($evidence.observed.$name -ne $true) { throw "Negative/control observation failed at $name" }
  }
  $interaction = Invoke-JsonSql -Sql "SELECT json_build_object('draftInteractions',count(*) FILTER (WHERE action='create_draft' AND result='applied'),'distinctDrafts',count(DISTINCT draft_id)) FROM knowledge_conflict_interactions WHERE candidate_id='$($evidence.candidateId)';"
  if ([long]$interaction.draftInteractions -ne 1 -or [long]$interaction.distinctDrafts -ne 1) { throw "Draft callback was not exactly-once" }
  foreach ($field in @('noConflictMemoryId','relatedSubjectMemoryId','permissionRevokedCandidateId','snapshotRevokedCandidateId')) { $null = Assert-Reference -Name $field -Value ([string]$evidence.$field) }
  $controls = Invoke-JsonSql -Sql "SELECT json_build_object('noConflictScans',(SELECT count(*) FROM knowledge_conflict_scan_inbox WHERE group_id='$pilot' AND group_memory_id='$($evidence.noConflictMemoryId)' AND terminal_outcome='no_conflict'),'noConflictCandidates',(SELECT count(*) FROM knowledge_conflict_candidates WHERE group_memory_id='$($evidence.noConflictMemoryId)'),'relatedScans',(SELECT count(*) FROM knowledge_conflict_scan_inbox WHERE group_id='$pilot' AND group_memory_id='$($evidence.relatedSubjectMemoryId)' AND terminal_outcome IN ('no_conflict','insufficient_evidence')),'relatedCandidates',(SELECT count(*) FROM knowledge_conflict_candidates WHERE group_memory_id='$($evidence.relatedSubjectMemoryId)'),'revokedCandidates',(SELECT count(*) FROM knowledge_conflict_candidates WHERE id IN ('$($evidence.permissionRevokedCandidateId)','$($evidence.snapshotRevokedCandidateId)') AND status='superseded'),'revokedDrafts',(SELECT count(*) FROM knowledge_conflict_interactions WHERE candidate_id IN ('$($evidence.permissionRevokedCandidateId)','$($evidence.snapshotRevokedCandidateId)') AND draft_id IS NOT NULL));"
  if ([long]$controls.noConflictScans -ne 1 -or [long]$controls.noConflictCandidates -ne 0 -or [long]$controls.relatedScans -ne 1 -or [long]$controls.relatedCandidates -ne 0 -or [long]$controls.revokedCandidates -ne 2 -or [long]$controls.revokedDrafts -ne 0) { throw "Control or revocation facts failed" }

  $script:FailedStep = 10
  $draft = Invoke-JsonSql -Sql "SELECT json_build_object('count',count(*),'riskCount',count(*) FILTER (WHERE revision.risk_level='medium'),'pathCount',count(*) FILTER (WHERE draft.status IN ('pending_confirmation','pending_review','needs_revision','rejected','published'))) FROM knowledge_drafts draft JOIN knowledge_draft_revisions revision ON revision.draft_id=draft.id AND revision.revision_number=draft.current_revision_number WHERE draft.id='$($evidence.draftId)' AND draft.source_group_id='$pilot' AND draft.origin_kind='knowledge_conflict';"
  if ([long]$draft.count -ne 1 -or [long]$draft.riskCount -ne 1 -or [long]$draft.pathCount -ne 1) { throw "Governed medium-risk update draft path failed" }
  Assert-DrainedActivity (Get-KnowledgeConflictActivityCounts)
  $conflictStatus = Invoke-RestMethod -Headers $irisHeaders -Uri http://localhost:3000/internal/knowledge-conflicts/status
  if ([long]$conflictStatus.scans.deadLettered -ne 0 -or [long]$conflictStatus.deliveries.outcomeUnknown -ne 0 -or [long]$conflictStatus.deliveries.terminalFailed -ne 0) { throw "Conflict runtime has unresolved terminal state" }
  Assert-CoreQueuesDrained (Invoke-RestMethod -Headers $irisHeaders -Uri http://localhost:3000/internal/status)
  foreach ($groupId in $nonPilotGroupIds) { Assert-CountsUnchanged -Before $script:BaselineGroupFacts[$groupId] -After (Get-GroupFactCounts $groupId) -Label "Nonpilot group facts" }

  $script:FailedStep = 11
  $script:FailedStep = 12
  return @{ result = "pass"; candidateId = $evidence.candidateId; draftId = $evidence.draftId; checkedAt = (Get-Date).ToUniversalTime().ToString('o') }
}

$acceptanceResult = $null
$primaryFailure = $null
try {
  $acceptanceResult = Invoke-KnowledgeConflictAcceptance
} catch {
  $primaryFailure = "Step $($script:FailedStep) failed"
} finally {
  Invoke-KnowledgeConflictRollback
  $summary = [ordered]@{
    exactCommitSha = $ApprovedCommitSha
    imageDigest = $ApprovedImageDigest
    pilotGroupId = $PilotGroupId
    controlGroupIds = $ControlGroupIds
    result = if ($null -eq $primaryFailure -and $script:RollbackErrors.Count -eq 0) { "pass" } else { "fail" }
    failedStep = if ($null -eq $primaryFailure) { $null } else { $script:FailedStep }
    rollbackPass = ($script:RollbackErrors.Count -eq 0)
    recordedAt = (Get-Date).ToUniversalTime().ToString('o')
  }
  $summary | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath "$EvidencePath.summary.json" -Encoding utf8
}
if ($null -ne $primaryFailure -or $script:RollbackErrors.Count -ne 0) {
  throw "Knowledge-conflict acceptance or rollback failed; inspect metadata-only summary"
}
```

Minimum private evidence JSON shape (values shown are placeholders and must never be committed):

```json
{
  "documentSourceId": "source_id",
  "snapshotId": "snapshot_id",
  "contentHash": "0000000000000000000000000000000000000000000000000000000000000000",
  "sourceVersion": "version_id",
  "groupMessageId": "message_id",
  "memoryId": "memory_id",
  "scanId": "scan_id",
  "candidateId": "candidate_id",
  "answerDeliveryId": "answer_delivery_id",
  "deliveryId": "delivery_id",
  "draftId": "draft_id",
  "noConflictMemoryId": "no_conflict_memory_id",
  "relatedSubjectMemoryId": "related_subject_memory_id",
  "permissionRevokedCandidateId": "permission_revoked_candidate_id",
  "snapshotRevokedCandidateId": "snapshot_revoked_candidate_id",
  "observed": {
    "answerBothSides": false,
    "answerNoResolution": false,
    "noCardBeforeApproval": false,
    "oneApprovedCard": false,
    "duplicateDeliveryNoEffect": false,
    "duplicateCallbackNoEffect": false,
    "noConflictControl": false,
    "relatedSubjectControl": false,
    "nonmemberDenied": false,
    "permissionRevocationBlocked": false,
    "snapshotRevocationBlocked": false
  }
}
```

The placeholder JSON is a schema example only. It is not acceptance evidence and contains no real
identifier, content, or credential.
