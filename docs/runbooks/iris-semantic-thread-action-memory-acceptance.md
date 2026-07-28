# Iris Semantic Thread And Action Memory Acceptance

This is an unexecuted real-Feishu gray-acceptance runbook for one approved group. It does not
authorize production rollout. Run it only after the controller's two-stage review. The default is
fail closed: global Iris is disabled, every known group is disabled, Caddy is stopped, proactive
speech is disabled, and thread/action allowlists are blank.

IRIS-CORE-002 and IRIS-CORE-003 are code implemented, but real Feishu gray acceptance remains
pending. IRIS-CORE-005 and IRIS-CORE-006 remain missing; this runbook must not enable proactive
speech, reminders, or follow-up messages.

## Operator Inputs

Work in one PowerShell 7 session. Do not put tokens, message text, or secrets in the transcript.
Create a fresh UTF-8 text export containing one Feishu group ID per line for every group where the
bot is currently a member. Obtain it from the authoritative Feishu bot membership/admin inventory
immediately before preflight. An incomplete, stale, empty, or placeholder export is a hard stop.

```powershell
$pilotGroupId = "<approved-group-id>"
$controlGroupId = "<non-approved-control-group-id>"
$botGroupInventoryPath = ".\artifacts\feishu-bot-current-groups.txt"
$publicBaseUrl = "https://<pilot-host>"
$compose = @("compose", "--env-file", ".env.pilot", "--file", "deploy/pilot/docker-compose.yml")

$irisHeaders = @{ Authorization = "Bearer $env:IRIS_INTERNAL_API_TOKEN" }
$irisOperatorHeaders = @{
  Authorization = "Bearer $env:IRIS_INTERNAL_API_TOKEN"
  "X-Iris-Operator" = "iris-semantic-gray"
}
```

`$controllerKeepEnabled` stays `$false` for normal acceptance, so successful acceptance uses the
same fail-closed cleanup as a failed run. Only an explicit controller decision made after all gates
pass may set it to `$true`.

## Required Helpers

Run these definitions before preflight.

```powershell
function Get-PilotEnv {
  $entries = Get-Content -LiteralPath ".env.pilot" |
    Where-Object { $_ -match '^\s*[^#][^=]*=' }
  ConvertFrom-StringData ($entries -join "`n")
}

function Set-PilotEnvValues {
  param([hashtable]$Values)
  $path = ".env.pilot"
  $lines = [Collections.Generic.List[string]](Get-Content -LiteralPath $path)
  foreach ($name in $Values.Keys) {
    $matches = @(0..($lines.Count - 1) | Where-Object { $lines[$_] -match "^$([regex]::Escape($name))=" })
    if ($matches.Count -ne 1) { throw "Expected exactly one $name assignment in .env.pilot" }
    $lines[$matches[0]] = "$name=$($Values[$name])"
  }
  Set-Content -LiteralPath $path -Value $lines -Encoding utf8NoBOM
}

function Invoke-PilotSql {
  param([Parameter(Mandatory)][string]$Sql)
  $pilotEnv = Get-PilotEnv
  $result = & docker @compose exec -T postgres psql -v ON_ERROR_STOP=1 `
    -U $pilotEnv.POSTGRES_USER -d $pilotEnv.POSTGRES_DB -Atc $Sql
  if ($LASTEXITCODE -ne 0) { throw "Pilot PostgreSQL query failed" }
  @($result)
}

function Get-CurrentBotGroupIds {
  if (-not (Test-Path -LiteralPath $botGroupInventoryPath)) {
    throw "Authoritative Feishu bot membership inventory is unavailable"
  }
  $ids = @(Get-Content -LiteralPath $botGroupInventoryPath |
    ForEach-Object { $_.Trim() } | Where-Object { $_ -ne "" } | Sort-Object -Unique)
  if ($ids.Count -eq 0 -or $ids -match '<|>') {
    throw "Feishu bot membership inventory is empty or contains placeholders"
  }
  $ids
}

function Assert-ExactDisabledGroupSet {
  param($Status, [string[]]$ExpectedGroupIds)
  $expected = @($ExpectedGroupIds | Sort-Object -Unique)
  $actual = @($Status.disabledGroupIds | Sort-Object -Unique)
  $difference = @(Compare-Object -ReferenceObject $expected -DifferenceObject $actual)
  if ($difference.Count -ne 0) {
    throw "Persisted disabledGroupIds differs from the exact expected set: $($difference | ConvertTo-Json -Compress)"
  }
}

function Assert-ProactiveSpeechDisabled {
  param($Status)
  if ($Status.capabilities.proactiveSpeech -ne $false) {
    throw "Persisted capabilities.proactiveSpeech is not strictly false"
  }
}

function Assert-DurableMutation {
  param($Mutation, [string]$Name)
  if ($Mutation.durable -ne $true) { throw "$Name was not durably persisted" }
}

function Get-ControlSnapshot {
  $sql = @"
SELECT json_build_object(
  'messages', (SELECT count(*) FROM conversation_messages WHERE chat_id = '$controlGroupId'),
  'memories', (SELECT count(*) FROM group_memories WHERE group_id = '$controlGroupId'),
  'threads', (SELECT count(*) FROM discussion_threads WHERE group_id = '$controlGroupId'),
  'actions', (SELECT count(*) FROM action_items WHERE group_id = '$controlGroupId'),
  'projections', (SELECT count(*) FROM conversation_state_memory_projections WHERE group_id = '$controlGroupId'),
  'repairs', (SELECT count(*) FROM conversation_state_projection_repairs WHERE group_id = '$controlGroupId')
)::text;
"@
  ((Invoke-PilotSql -Sql $sql) -join "") | ConvertFrom-Json
}

function Assert-ControlSnapshotUnchanged {
  param($Before, $After)
  if (($Before | ConvertTo-Json -Compress) -cne ($After | ConvertTo-Json -Compress)) {
    throw "Disabled control group gained message/state/memory/projection data"
  }
}

function Get-DrainSnapshot {
  $status = Invoke-RestMethod -Headers $irisHeaders -Uri http://localhost:3000/internal/status
  $events = Invoke-RestMethod -Headers $irisHeaders -Uri http://localhost:3000/internal/events/status
  $extraction = Invoke-RestMethod -Headers $irisHeaders `
    -Uri http://localhost:3000/internal/memory-extraction/status
  $state = Invoke-RestMethod -Headers $irisHeaders `
    -Uri http://localhost:3000/internal/conversation-state/status

  [long]$eventProcessing = & docker @compose exec -T redis redis-cli LLEN iris:events:raw:processing
  if ($LASTEXITCODE -ne 0) { throw "Unable to read raw-event processing list" }
  [long]$documentSyncProcessing = & docker @compose exec -T redis redis-cli LLEN iris:documents:sync:processing
  if ($LASTEXITCODE -ne 0) { throw "Unable to read document-sync processing list" }
  [long]$documentReindexProcessing = & docker @compose exec -T redis redis-cli LLEN iris:reindex:documents:processing
  if ($LASTEXITCODE -ne 0) { throw "Unable to read document-reindex processing list" }

  [ordered]@{
    eventPending = [long]$events.pendingEventCount
    eventProcessing = $eventProcessing
    eventDlq = [long]$events.deadLetterEventCount
    documentPending = [long]$status.components.documentSync.pendingJobCount
    documentProcessing = $documentSyncProcessing
    documentDlq = [long]$status.components.documentSync.deadLetterJobCount
    reindexPending = [long]$status.components.reindex.pendingJobCount
    reindexProcessing = $documentReindexProcessing
    reindexDlq = [long]$status.components.reindex.deadLetterJobCount
    pendingJobCount = [long]$extraction.pendingJobCount
    processingJobCount = [long]$extraction.processingJobCount
    delayedJobCount = [long]$extraction.delayedJobCount
    deadLetterJobCount = [long]$extraction.deadLetterJobCount
    pendingProjectionRepairCount = [long]$extraction.pendingProjectionRepairCount
    failedProjectionRepairCount = [long]$extraction.failedProjectionRepairCount
    projectionProcessing = [long]$state.projectionRepairs.processing
  }
}

function Assert-ZeroDrain {
  param($Snapshot)
  [long]$documentSyncProcessing = $Snapshot.documentProcessing
  [long]$documentReindexProcessing = $Snapshot.reindexProcessing
  if ($documentSyncProcessing -ne 0) { throw "iris:documents:sync:processing is not empty" }
  if ($documentReindexProcessing -ne 0) { throw "iris:reindex:documents:processing is not empty" }
  $nonZero = @($Snapshot.GetEnumerator() | Where-Object { [long]$_.Value -ne 0 })
  if ($nonZero.Count -ne 0) {
    throw "Queue/DLQ/repair zero gate failed: $($Snapshot | ConvertTo-Json -Compress)"
  }
}

function Wait-ConversationDrain {
  param([int]$TimeoutSeconds = 120)
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  do {
    $snapshot = Get-DrainSnapshot
    if (@($snapshot.GetEnumerator() | Where-Object { [long]$_.Value -ne 0 }).Count -eq 0) {
      return $snapshot
    }
    Start-Sleep -Seconds 5
  } while ((Get-Date) -lt $deadline)
  throw "In-flight work did not drain while ingress remained disabled"
}

function Assert-QueuesNotGrowing {
  $before = Get-DrainSnapshot
  Start-Sleep -Seconds 10
  $after = Get-DrainSnapshot
  foreach ($name in $before.Keys) {
    if ([long]$after[$name] -gt [long]$before[$name]) {
      throw "$name grew after fail-closed cleanup"
    }
  }
}

function Assert-FailClosedState {
  param([string[]]$ExpectedDisabledGroupIds)
  $closed = Invoke-RestMethod -Headers $irisHeaders `
    -Uri http://localhost:3000/internal/runtime-control/status
  if ($closed.globalEnabled -ne $false -or $closed.desiredGlobalEnabled -ne $false) {
    throw "Runtime-control global state is not persistently disabled"
  }
  Assert-ExactDisabledGroupSet -Status $closed -ExpectedGroupIds $ExpectedDisabledGroupIds
  Assert-ProactiveSpeechDisabled -Status $closed
  $runningServices = @(& docker @compose ps --status running --services)
  if ($LASTEXITCODE -ne 0 -or $runningServices -contains "caddy") {
    throw "Caddy is not stopped"
  }
}

function Invoke-RollbackStep {
  param([string]$Name, [scriptblock]$Action, [Collections.Generic.List[Exception]]$RollbackErrors)
  try { & $Action } catch {
    $RollbackErrors.Add([Exception]::new("Rollback step '$Name' failed", $_.Exception))
  }
}

function Invoke-FailClosedRollback {
  param([string[]]$KnownGroupIds, [string[]]$NonPilotGroupIds)
  $rollbackErrors = [Collections.Generic.List[Exception]]::new()

  Invoke-RollbackStep "disable global" {
    $mutation = Invoke-RestMethod -Method Post -Headers $irisOperatorHeaders `
      -Uri http://localhost:3000/internal/runtime-control/global `
      -ContentType "application/json" -Body '{"enabled":false}'
    Assert-DurableMutation $mutation "global disable"
  } $rollbackErrors
  Invoke-RollbackStep "disable pilot" {
    $mutation = Invoke-RestMethod -Method Post -Headers $irisOperatorHeaders `
      -Uri "http://localhost:3000/internal/runtime-control/groups/$pilotGroupId" `
      -ContentType "application/json" -Body '{"enabled":false}'
    Assert-DurableMutation $mutation "pilot disable"
  } $rollbackErrors
  Invoke-RollbackStep "stop caddy" {
    $dockerOutput = & docker @compose stop caddy
    if ($LASTEXITCODE -ne 0) { throw "docker compose stop caddy failed: $dockerOutput" }
  } $rollbackErrors
  foreach ($groupId in $nonPilotGroupIds) {
    Invoke-RollbackStep "disable group $groupId" {
      $mutation = Invoke-RestMethod -Method Post -Headers $irisOperatorHeaders `
        -Uri "http://localhost:3000/internal/runtime-control/groups/$groupId" `
        -ContentType "application/json" -Body '{"enabled":false}'
      Assert-DurableMutation $mutation "group disable $groupId"
    } $rollbackErrors
  }
  Invoke-RollbackStep "persist proactive false" {
    $mutation = Invoke-RestMethod -Method Patch -Headers $irisOperatorHeaders `
      -Uri http://localhost:3000/internal/runtime-control/capabilities `
      -ContentType "application/json" -Body '{"proactiveSpeech":false}'
    Assert-DurableMutation $mutation "proactiveSpeech disable"
  } $rollbackErrors
  Invoke-RollbackStep "wait for in-flight work" {
    $null = Wait-ConversationDrain
  } $rollbackErrors
  Invoke-RollbackStep "restore disabled extraction env" {
    Set-PilotEnvValues ([ordered]@{
      IRIS_THREAD_EXTRACTION_GROUP_IDS=""
      IRIS_ACTION_EXTRACTION_GROUP_IDS=""
      IRIS_MEMORY_EXTRACTION_ENABLED="false"
    })
    # Persisted rollback target: IRIS_MEMORY_EXTRACTION_ENABLED=false
  } $rollbackErrors
  Invoke-RollbackStep "rebuild private Core" {
    $dockerOutput = & docker @compose up --detach --build --force-recreate --wait --wait-timeout 120 core
    if ($LASTEXITCODE -ne 0) { throw "Core rebuild failed: $dockerOutput" }
  } $rollbackErrors
  Invoke-RollbackStep "verify persisted fail-closed state" {
    Assert-FailClosedState -ExpectedDisabledGroupIds $KnownGroupIds
  } $rollbackErrors
  Invoke-RollbackStep "verify queues no longer grow" {
    Assert-QueuesNotGrowing
  } $rollbackErrors

  $rollbackErrors.ToArray()
}
```

If the drain wait fails, the helper records that failure, continues every later cleanup step, and
leaves global/group ingress disabled. Rollback failures are aggregated with the primary acceptance
failure instead of replacing it.

## Exhaustive Group Inventory

Keep global Iris disabled while building the union of current bot memberships and historical/current
database state. The SQL inventory includes conversation messages, group memory, threads, and actions.

```powershell
if ($pilotGroupId -eq $controlGroupId -or $pilotGroupId -match '<|>' -or $controlGroupId -match '<|>') {
  throw "Pilot/control group IDs must be distinct real IDs"
}

$globalOff = Invoke-RestMethod -Method Post -Headers $irisOperatorHeaders `
  -Uri http://localhost:3000/internal/runtime-control/global `
  -ContentType "application/json" -Body '{"enabled":false}'
Assert-DurableMutation $globalOff "preflight global disable"

$currentBotGroupIds = @(Get-CurrentBotGroupIds)
$databaseGroupIds = @(Invoke-PilotSql -Sql @"
SELECT group_id FROM (
  SELECT chat_id AS group_id FROM conversation_messages
  UNION SELECT group_id FROM group_memories
  UNION SELECT group_id FROM discussion_threads
  UNION SELECT group_id FROM action_items
) known_database_groups
WHERE group_id IS NOT NULL AND group_id <> ''
ORDER BY group_id;
"@ | ForEach-Object { $_.Trim() } | Where-Object { $_ -ne "" } | Sort-Object -Unique)
$knownGroupIds = @($currentBotGroupIds + $databaseGroupIds | Sort-Object -Unique)
$nonPilotGroupIds = @($knownGroupIds | Where-Object { $_ -ne $pilotGroupId })

if ($currentBotGroupIds -notcontains $pilotGroupId) { throw "Pilot group is not in current bot membership" }
if ($currentBotGroupIds -notcontains $controlGroupId) { throw "Control group is not in current bot membership" }

$pilotOff = Invoke-RestMethod -Method Post -Headers $irisOperatorHeaders `
  -Uri "http://localhost:3000/internal/runtime-control/groups/$pilotGroupId" `
  -ContentType "application/json" -Body '{"enabled":false}'
Assert-DurableMutation $pilotOff "preflight pilot disable"
foreach ($groupId in $nonPilotGroupIds) {
  $groupOff = Invoke-RestMethod -Method Post -Headers $irisOperatorHeaders `
    -Uri "http://localhost:3000/internal/runtime-control/groups/$groupId" `
    -ContentType "application/json" -Body '{"enabled":false}'
  Assert-DurableMutation $groupOff "preflight disable $groupId"
}

$proactiveOff = Invoke-RestMethod -Method Patch -Headers $irisOperatorHeaders `
  -Uri http://localhost:3000/internal/runtime-control/capabilities `
  -ContentType "application/json" -Body '{"proactiveSpeech":false}'
Assert-DurableMutation $proactiveOff "preflight proactiveSpeech disable"
```

Any failed inventory query or group-disable mutation prohibits global enable. Do not assume the
control group represents all non-approved groups.

## Private Deployment And Boundary Gates

Set exactly the approved group in both allowlists. Every other group remains blank/disabled. Retain
the exact pilot thresholds.

```powershell
Set-PilotEnvValues ([ordered]@{
  IRIS_MEMORY_EXTRACTION_ENABLED = "true"
  IRIS_THREAD_EXTRACTION_GROUP_IDS = $pilotGroupId
  IRIS_ACTION_EXTRACTION_GROUP_IDS = $pilotGroupId
  IRIS_THREAD_CANDIDATE_CONFIDENCE_FLOOR = "0.65"
  IRIS_MEMORY_EXTRACTION_MIN_CONFIDENCE = "0.85"
})
& docker @compose stop caddy
if ($LASTEXITCODE -ne 0) { throw "Unable to stop Caddy" }
& docker @compose up --detach --build --force-recreate postgres redis migrate ai-worker core
if ($LASTEXITCODE -ne 0) { throw "Private runtime deployment failed" }
```

Run `npm run readiness -- --env-file .env.pilot`. Require `GET /internal/readiness` to return
`ok: true`, `GET /internal/ingress-readiness` to return `ok: true` and `status: "ready"`, and every
enabled component in `GET /internal/status` to be healthy. Confirm AI Worker has no published port,
Caddy contains no `/internal/*` route, and Caddy routes only public `/health` and `/feishu/events` to
Core. Start Caddy; require public `/health` `200`, public `/internal/*` `404`, and the callback
boundary to reject invalid verification/signature requests without processing an event.

```powershell
$dockerOutput = & docker @compose up --detach caddy
if ($LASTEXITCODE -ne 0) { throw "Unable to start Caddy: $dockerOutput" }
```

Immediately before global enable, create a second fresh authoritative Feishu membership export at
the same path, then run this gate. If the bot is in any uninventoried group, the run fails closed and
does not continue.

```powershell
$freshBotGroupIds = @(Get-CurrentBotGroupIds)
$membershipDelta = @(Compare-Object -ReferenceObject $currentBotGroupIds -DifferenceObject $freshBotGroupIds)
if ($membershipDelta.Count -ne 0) { throw "Bot membership changed; rebuild the complete group inventory" }
$uninventoried = @($freshBotGroupIds | Where-Object { $knownGroupIds -notcontains $_ })
if ($uninventoried.Count -ne 0) { throw "Bot remains in an uninventoried group; global enable prohibited" }

$pilotOn = Invoke-RestMethod -Method Post -Headers $irisOperatorHeaders `
  -Uri "http://localhost:3000/internal/runtime-control/groups/$pilotGroupId" `
  -ContentType "application/json" -Body '{"enabled":true}'
Assert-DurableMutation $pilotOn "pilot enable"

$statusBeforeGlobalEnable = Invoke-RestMethod -Headers $irisHeaders `
  -Uri http://localhost:3000/internal/runtime-control/status
Assert-ExactDisabledGroupSet -Status $statusBeforeGlobalEnable -ExpectedGroupIds $nonPilotGroupIds
Assert-ProactiveSpeechDisabled -Status $statusBeforeGlobalEnable
```

The strict disabled-set comparison catches stale or unknown persisted group state. Any mismatch,
including an extra or missing ID, prohibits global enable and requires inventory reconciliation.

## Gray Execution Wrapper

Keep the remaining enable and acceptance commands inside this wrapper. Set the attempt flag before
the mutation because a timeout can hide a successful durable write.

```powershell
$controllerKeepEnabled = $false
$globalEnableAttempted = $false
$acceptancePassed = $false
$primaryError = $null
$rollbackErrors = @()

try {
  # GLOBAL_ENABLE
  $globalEnableAttempted = $true
  $globalOn = Invoke-RestMethod -Method Post -Headers $irisOperatorHeaders `
    -Uri http://localhost:3000/internal/runtime-control/global `
    -ContentType "application/json" -Body '{"enabled":true}'
  Assert-DurableMutation $globalOn "global enable"

  $statusAfterGlobalEnable = Invoke-RestMethod -Headers $irisHeaders `
    -Uri http://localhost:3000/internal/runtime-control/status
  Assert-ExactDisabledGroupSet -Status $statusAfterGlobalEnable -ExpectedGroupIds $nonPilotGroupIds
  Assert-ProactiveSpeechDisabled -Status $statusAfterGlobalEnable

  # Run the control-group negative test and human acceptance conversation below in this try block.
  $controlBefore = Get-ControlSnapshot
  $null = Read-Host "Send one ordinary message and one @Iris mention in the control group; press Enter after two extraction intervals"
  $controlAfter = Get-ControlSnapshot
  Assert-ControlSnapshotUnchanged -Before $controlBefore -After $controlAfter
  $replyObservation = Read-Host "Confirm no Feishu reply appeared in the control group by typing NO_REPLY"
  if ($replyObservation -cne "NO_REPLY") { throw "Control group reply observation failed" }

  $postEnableBotGroups = @(Get-CurrentBotGroupIds)
  $postEnableUnknown = @($postEnableBotGroups | Where-Object { $knownGroupIds -notcontains $_ })
  if ($postEnableUnknown.Count -ne 0) { throw "Bot is in an uninventoried group after global enable" }

  $null = Read-Host "Complete the six approved-group human steps and evidence checks below; press Enter to drain"
  $drained = Wait-ConversationDrain
  Assert-ZeroDrain -Snapshot $drained

  $readiness = Invoke-RestMethod -Headers $irisHeaders -Uri http://localhost:3000/internal/readiness
  $ingress = Invoke-RestMethod -Headers $irisHeaders `
    -Uri http://localhost:3000/internal/ingress-readiness
  if ($readiness.ok -ne $true -or $ingress.ok -ne $true -or $ingress.status -ne "ready") {
    throw "Final readiness gate failed"
  }
  $acceptancePassed = $true
} catch {
  $primaryError = $_.Exception
} finally {
  if ($globalEnableAttempted -and ((-not $acceptancePassed) -or (-not $controllerKeepEnabled))) {
    $rollbackErrors = @(Invoke-FailClosedRollback `
      -KnownGroupIds $knownGroupIds -NonPilotGroupIds $nonPilotGroupIds)
  }
}

$allErrors = [Collections.Generic.List[Exception]]::new()
if ($null -ne $primaryError) { $allErrors.Add($primaryError) }
foreach ($rollbackError in $rollbackErrors) { $allErrors.Add($rollbackError) }
if ($allErrors.Count -ne 0) {
  throw [AggregateException]::new("Gray acceptance and/or fail-closed cleanup failed", $allErrors.ToArray())
}
```

Any failure after global enable therefore attempts, in order: global disable; pilot and all other
known group disables; proactive disable; Caddy stop; bounded in-flight drain; blank thread/action
allowlists; memory-extraction disable; private Core rebuild; persisted fail-closed verification; and
queue/DLQ/repair no-growth verification. A primary failure never skips cleanup.

## Provider-Recovery Gate And Ordered Replay

If the semantic gray gate is blocked by Gemini capacity or provider availability, do not keep
probing. Each recovery window allows exactly one minimal V2 JSON Schema probe before any replay.
The probe must use the AI Worker private endpoint and the configured `IRIS_AI_WORKER_TOKEN`; do not
send it through Caddy, Feishu, or the public Core boundary.

On the VPS, the bounded helper below performs the fail-closed preflight and exactly one private AI
Worker V2 probe from inside the `core` container. It does not replay DLQ entries and prints only
status code, safe classification, optional retry-after, and DLQ count:

```bash
IRIS_PILOT_ENV_FILE=.env.pilot ./deploy/pilot/semantic-recovery-probe.sh
```

If the probe returns any non-success status, including `429`, `502 invalid_model_response`, `503`, or
timeout, stop the recovery window immediately:

- keep `globalEnabled=false` and `desiredGlobalEnabled=false`;
- keep pilot, control, and historical groups disabled;
- keep Caddy stopped;
- do not replay semantic DLQ items;
- do not make additional model requests in the same window;
- record only the bounded classification and upstream status, never prompt or model body content.

If the probe succeeds, continue with Caddy still stopped. For replay only, the operator may
briefly open a private processing window by enabling global runtime and enabling the approved pilot
group while keeping every non-pilot group disabled and `proactiveSpeech=false`. This is required
because memory extraction runtime gates require both `canProcessIncomingEvent(groupId)` and
`canReadGroupContext(groupId)`. Do not start Caddy during this private window.

If the six gray messages are present as semantic DLQ entries, use the bounded ordered DLQ helper:

```bash
IRIS_PILOT_ENV_FILE=.env.pilot \
IRIS_SEMANTIC_REPLAY_CONFIRM=REPLAY_SEMANTIC_DLQ_ONE_BY_ONE \
IRIS_SEMANTIC_REPLAY_PILOT_GROUP_ID=<approved-pilot-group-id> \
./deploy/pilot/semantic-dlq-replay-one-by-one.sh
```

The helper first runs the single-probe preflight, stops Caddy, opens only the private pilot processing
window, replays each original DLQ item individually, and returns the runtime to fail-closed. It must
not be used as evidence that the public Feishu path passed; real Feishu gray acceptance still needs
the separate human-sent messages below.

If there are no semantic DLQ entries, but the gray marker messages already have extraction requests
with `skipped` or stale `completed` results from an earlier fail-closed window, use the bounded
ordered reseed helper instead:

```bash
IRIS_PILOT_ENV_FILE=.env.pilot \
IRIS_SEMANTIC_RESEED_CONFIRM=RESET_SEMANTIC_MESSAGES_ONE_BY_ONE \
IRIS_SEMANTIC_RESEED_PILOT_GROUP_ID=<approved-pilot-group-id> \
IRIS_SEMANTIC_RESEED_MARKER=<literal-gray-marker> \
./deploy/pilot/semantic-reseed-from-messages-one-by-one.sh
```

The reseed helper resets only extraction request/run metadata for messages in the approved pilot
group containing the literal marker, rejects runs that include non-marker requests, keeps Caddy
stopped, opens only the private pilot processing window, enqueues one marker request at a time, waits
for drain after each request, and returns runtime to fail-closed. It must not be used for arbitrary
production messages.

Prefer a fresh isolated internal group over reseeding when six clean marker messages can be created
without modifying append-only history. The fresh helper refuses any marker message that already has
an extraction request and refuses a group that already contains thread or action state:

```bash
IRIS_PILOT_ENV_FILE=.env.pilot \
IRIS_SEMANTIC_FRESH_ACCEPTANCE_CONFIRM=RUN_FRESH_SEMANTIC_ACCEPTANCE_ONE_BY_ONE \
IRIS_SEMANTIC_FRESH_ACCEPTANCE_GROUP_ID=<fresh-internal-group-id> \
IRIS_SEMANTIC_FRESH_ACCEPTANCE_MARKER=<literal-gray-marker> \
IRIS_SEMANTIC_FRESH_ACCEPTANCE_KNOWN_GROUP_IDS=<exhaustive-comma-separated-group-inventory> \
./deploy/pilot/semantic-fresh-acceptance-one-by-one.sh
```

The helper requires exactly six ordered marker messages and validates persisted evidence before
registration. It opens no public ingress, registers and enqueues exactly one request at a time, and
returns global/group runtime to fail-closed. After every completed request it requires the persisted
run to have enabled `memory`, `thread`, and `action`, then proves the cumulative lifecycle:
thread creation, promotion, action creation, action completion, thread resolution, and thread
reopening. Entity counts, links, owners, versions, lifecycle events, and event evidence must all
match; a completed extraction that produced zero semantic candidates therefore fails immediately.
Creating an action from an explicit commitment also attaches that commitment evidence to the
existing discussion thread. The thread therefore advances from promoted version 2 to version 3
with an `evidence_attached` event before later resolution (version 4) and reopening (version 5).
The fourth, mention-question step is the deliberate exception: it must leave the semantic lifecycle
unchanged. The fifth message must both complete the action and resolve the thread, and the persisted
Feishu action owner must exactly match the sender of both the commitment and completion messages.
The known group list must be an exhaustive, current inventory; the helper refuses to open the
private window when Postgres contains a group outside that list or when any non-target group would
become enabled. Cleanup attempts every known group independently and proves the exact disabled set.
The acceptance process publishes a unique run token before Node starts, is bounded by a timeout
inside the Core container, and cleanup terminates every `/proc` process carrying that token before
proving the runtime closed. The outer Compose command has a later attach timeout, both Caddy stops
are bounded, and each internal HTTP/Postgres/Redis operation has a real transport or server-side
timeout of 10 seconds. Operators may set
`IRIS_SEMANTIC_FRESH_ACCEPTANCE_COMMAND_TIMEOUT_SECONDS` (60-3,600) and
`IRIS_SEMANTIC_FRESH_ACCEPTANCE_REQUEST_TIMEOUT_MS` (1,000-30,000) without removing those bounds.
A run with
`invalid_model_response_retry` is not terminal while its request remains pending or processing and
the queue still contains bounded retry work. The helper continues waiting through that retry. It
stops on a skipped request, DLQ entry, stalled request, timeout, or unknown status. It never deletes
or updates prior extraction history.

Replay semantic DLQ entries one at a time in original `enqueuedAt` order. After each replay, wait for
memory extraction `pendingJobCount`, `processingJobCount`, and `delayedJobCount` to return to zero
before replaying the next item. If any replay produces a new DLQ, invalid response, rate limit,
timeout, stale input, duplicate state, cross-group state, or projection repair failure, stop
immediately and run the fail-closed rollback. Never batch the six semantic DLQ items into one replay,
because doing so can hide whether later evidence correctly references the newly created thread or
action from earlier evidence.

After all replayable semantic DLQ entries are processed, require:

- semantic DLQ count is zero;
- the pilot group has the expected evidence-bound thread/action lifecycle with no duplicates;
- the control group has no new messages, memories, threads, actions, or projections;
- every event/document/reindex/memory pending, processing, delayed, DLQ, and projection-repair count
  is zero;
- global runtime and all known groups are returned to fail-closed state unless a controller has
  explicitly approved the next real Feishu gray step.

The read-only internal inspector can check the replay result without opening Caddy, replaying DLQ
items, or making another model request:

```bash
IRIS_PILOT_ENV_FILE=.env.pilot \
IRIS_SEMANTIC_ACCEPTANCE_PILOT_GROUP_ID=<approved-pilot-group-id> \
IRIS_SEMANTIC_ACCEPTANCE_CONTROL_GROUP_ID=<optional-empty-control-group-id> \
./deploy/pilot/semantic-acceptance-inspect.sh
```

It requires one reopened pilot thread with append-only evidence, one completed action bound to that
thread, zero semantic DLQ, zero queue/repair counts, fail-closed runtime, and an empty control group
when `IRIS_SEMANTIC_ACCEPTANCE_CONTROL_GROUP_ID` is provided.

## Control-Group Negative Test

The wrapper selects the non-approved `$controlGroupId` and captures `$controlBefore` after global
enable. A human sends one ordinary message and one mention question in that control group. After at
least two extraction intervals, `$controlAfter` must be byte-for-byte equivalent by field: no new
conversation message, thread/action state, group memory, memory projection, or projection repair.
There must be no Feishu reply. Existing unrelated historical rows are allowed only because the test
compares before and after counts.

If a refreshed membership inventory reveals any uninventoried group, or the control snapshot or
no-reply observation changes, acceptance fails and the wrapper runs fail-closed cleanup.

## Human Acceptance Conversation

Use a unique marker such as `IRIS-GRAY-<date>-ALPHA`. Humans send these messages in the approved
group; the operator does not send them through an API.

Before registering or replaying any marker message, read its persisted `conversation_messages.text`
value back from Postgres. Refuse the run if any message contains Unicode replacement characters or
long high-density runs of ASCII question marks, because that is evidence of a lossy terminal/SSH
encoding path rather than valid conversation evidence. Synthetic internal fixtures must cross Windows/SSH
boundaries as UTF-8 files or base64-encoded bytes and must be compared byte-for-byte after insert.
Never interpret a schema-valid empty model response from corrupted evidence as a semantic-model
acceptance result.

1. Ordinary discussion without mentioning Iris: introduce the marker, a decision still under
   discussion, and one relevant fact.
2. Evidence promotion without mentioning Iris: continue the same topic. Poll until the same
   evidence-bound thread is `open`, not `candidate`.
3. Explicit commitment: one participant personally commits to one concrete action. Poll until
   exactly one matching `open` action has the correct Feishu owner and evidence message ID. The
   same evidence must be attached to the existing thread as version 3; this is not a duplicate
   thread or a failed extraction.
4. Mention question: mention Iris and ask for the current decision and commitment. Require one
   accurate answer grounded only in this group's open thread/action state.
5. Completion: the owner explicitly completes the action and resolves the discussion. Poll until the
   action is `completed` and the thread is `resolved`.
6. Reopening without mentioning Iris: add explicit new evidence. Poll until the same canonical
   thread is `open` at a higher version with no duplicate thread/action.

Inspect only loopback operator routes:

```powershell
$pilotThreads = Invoke-RestMethod -Headers $irisHeaders `
  -Uri "http://localhost:3000/internal/conversation-state/groups/$pilotGroupId/threads?limit=20"
$pilotActions = Invoke-RestMethod -Headers $irisHeaders `
  -Uri "http://localhost:3000/internal/conversation-state/groups/$pilotGroupId/actions?limit=20"
```

Require append-only events and exact evidence IDs for every transition. From the first ordinary
message through at least two extraction intervals after reopening, allow only the direct answer to
the explicit @Iris question. Any unsolicited reminder, follow-up, status update, or other Iris
message fails acceptance. Require the drain snapshot to be all numeric zero, including pending,
processing, delayed, DLQ, and projection-repair counts and the exact Redis processing lists
`iris:events:raw:processing`, `iris:documents:sync:processing`, and
`iris:reindex:documents:processing`.

### Physical Evidence Deletion

Only a named operator may invoke the loopback deletion route. It requires both the existing internal
Bearer token and a bounded `x-iris-operator` value; do not expose it through Caddy or a public route.

```powershell
$deleteHeaders = @{
  Authorization = "Bearer $env:IRIS_INTERNAL_API_TOKEN"
  'x-iris-operator' = $env:IRIS_OPERATOR_ID
}
$deletion = Invoke-RestMethod -Method Delete -Headers $deleteHeaders `
  -Uri "http://localhost:3000/internal/conversation-state/groups/$pilotGroupId/messages/$messageId/evidence"
```

The response contains only deletion counts. A second request must return `200` with
`status=already_deleted` and zero counts. Verify that the message row is physically absent, affected
thread/action content is absent from the operator reads, and no projection-derived group memory is
retrievable. The persistent replay tombstone may contain only provider/message/chat identity and the
deletion time; it must not contain message text, derived content, or the operator hint. Record only
IDs, counts, and content-free `evidence_deleted` event metadata; never copy the deleted message or
derived content into evidence.

## Evidence And Exit

Record the deployed commit, complete inventory source/timestamps, pilot/control IDs, state and event
IDs, count-only status JSON, readiness results, and observed Feishu messages. Do not record message
content or secrets. Unless the controller explicitly chose to keep the accepted runtime enabled,
successful cleanup must prove persisted global false, every known group including the pilot in the
exact disabled set, proactive false, Caddy stopped, blank thread/action allowlists,
`IRIS_MEMORY_EXTRACTION_ENABLED=false`, and queues/DLQs/repairs no longer growing.

Do not restart Caddy after cleanup. Real Feishu gray acceptance and the final release decision remain
controller actions; this runbook does not claim complete Iris delivery.
