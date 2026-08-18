# Iris Cross-Group Document Grants Acceptance

Status: unexecuted. This controller proves one answer-only cross-group document loop with one
source group, one distinct grantee group, and one distinct control group. It never authorizes
cross-group memory, knowledge drafts, proactive delivery, wildcard grants, or broad rollout.

The controller starts and ends fail-closed. Evidence is private and metadata-only: exact IDs,
versions, hashes, counts, timestamps, and pass/fail facts. Do not record source, prompt, message,
or reply text, callback payloads, credentials, or authorization material.

Required environment inputs are `APPROVED_COMMIT_SHA`, `APPROVED_CI_RUN_ID`,
`IRIS_APPROVED_IMAGE_DIGEST`, `SOURCE_GROUP_ID`, `GRANTEE_GROUP_ID`, `CONTROL_GROUP_ID`,
`DOCUMENT_SOURCE_ID`, `IRIS_BOT_GROUP_INVENTORY_PATH`, and `IRIS_CROSS_GROUP_EVIDENCE_PATH`.
The evidence JSON is stored outside the repository with mode `0600` or the Windows equivalent.
The three group IDs must be exact, current, and pairwise distinct.

## Step 1: Exact SHA, CI, And Private Preflight

Require a clean detached checkout at `APPROVED_COMMIT_SHA`, successful required checks for that
exact SHA, and the running Core image matching `IRIS_APPROVED_IMAGE_DIGEST`. Stop Caddy first. Do
not proceed if migration `0051_document_source_group_grants.sql` is absent, status counts are
unreadable, any pilot grant is active, or any queue/DLQ/outbox is nonzero.

## Step 2: Backup, Migration, And Default Denial

Create and verify the encrypted Postgres/Redis backup. Start only private services. Re-attest
global and desired runtime disabled, all three groups disabled, answering capability disabled,
Caddy stopped, and zero active grants for the pilot source. This is the pre-grant denial baseline.

## Step 3: Three-Group And Source Binding

Verify `DOCUMENT_SOURCE_ID` is one `group_visible_document` evidenced by `SOURCE_GROUP_ID` and not
by either other group. Confirm source, grantee, and control IDs are exact and pairwise distinct.
Record only source ID, current snapshot ID/hash/version, and timestamps. A source may retain the
normal `unknown` permission projection; `denied` and `stale` remain ineligible, and the retrieval
and final-send paths must still pass their live Feishu permission checks.

## Step 4: Pre-Grant And Control Denial

Enable only the bounded answer path and the three group ingress paths, then start Caddy last. Ask
the same bounded marker question from the grantee and control groups before any grant. Require zero
prompt grant bindings, zero `answer_reply_source_traces` for the pilot source, and zero disclosure
from both groups. Stop Caddy after the two observations.

## Step 5: Exact Grant And Grantee Answer

Read the existing exact source/grantee projection first. It must be absent or revoked. Create or
regrant through the authenticated internal API with that baseline version, require the next version
to be active, and require one append-only `granted` event. Start Caddy, ask once from
the grantee, then stop Caddy. Require one delivery whose source trace binds the exact grant ID,
version, grantor group, grantee group, source, snapshot, and fragment. The control group remains
denied.

## Step 6: Prepared-Answer Revocation And Begin-Send Race

The exact-SHA CI run must execute the real-PostgreSQL prepared-answer revocation and
begin-send/revoke serialization tests. Accept only send-won-before-revoke or
revoke-won-before-send and reject every send-after-revoke result. Live, revoke the active version, ask
again from the grantee, and require no pilot-source trace or disclosure. No production pause hook
is enabled. The reviewed prepared-answer test also requires the losing path to become
`permission_blocked` before external I/O.

## Step 7: Regrant, Replay, And Final Drain

Regrant the revoked row at its current version, requiring the next version active and exactly one new
`granted` event. Replay the identical operation key and expected version; require `already_applied`, event delta zero,
and no duplicate delivery. Ask once from the grantee and once from the control. Require one exact
grantee delivery and continued control denial. Stop Caddy and wait for final queue/DLQ/outbox and
unresolved answer counts to reach zero.

## Step 8: Unconditional Rollback And Evidence Hash

Every exit revokes the current pilot grant, disables all three groups and global/capability state,
stops Caddy, drains durable work, and verifies mutable fingerprints remain stable across a quiet
window. Append-only grant and answer facts must not decrease. Hash the private artifact, record only
its SHA-256 and timestamp, and leave active pilot grant count zero.

## Attached PowerShell Controller

Run this block as one attached process. Do not copy individual enablement commands into another
shell. Overwrite the private evidence JSON after each requested human observation. It supplies only
fresh message IDs and disclosure booleans; every machine fact is queried live from PostgreSQL/API.

```powershell
$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$script:KnownGroupIds = @()
$script:BaselineAppendOnlyEventCount = [int64]0
$script:RollbackErrors = @()

function Get-RequiredProperty {
  param([Parameter(Mandatory)][object]$Value, [Parameter(Mandatory)][string]$Name)
  if ($Value -is [Collections.IDictionary]) {
    if (-not $Value.Contains($Name)) { throw "missing required property $Name" }
    return $Value[$Name]
  }
  if ($Value.PSObject.Properties.Name -notcontains $Name) { throw "missing required property $Name" }
  return $Value.$Name
}

function Assert-Reference {
  param([Parameter(Mandatory)][string]$Name, [Parameter(Mandatory)][string]$Value)
  if ($Value -cnotmatch '^[A-Za-z0-9:_-]{1,512}$') { throw "$Name is missing or unsafe" }
  return $Value
}

function Assert-MetadataOnlyValue {
  param([AllowNull()][object]$Value)
  if ($null -eq $Value -or $Value -is [string] -or $Value -is [ValueType]) { return }
  if ($Value -is [Collections.IEnumerable] -and $Value -isnot [Collections.IDictionary]) {
    foreach ($item in $Value) { Assert-MetadataOnlyValue $item }
    return
  }
  $properties = if ($Value -is [Collections.IDictionary]) {
    @($Value.Keys | ForEach-Object { [pscustomobject]@{ Name = [string]$_; Value = $Value[$_] } })
  } else { @($Value.PSObject.Properties) }
  foreach ($property in $properties) {
    if ($property.Name -in @(
      "sourceText", "messageText", "replyText", "promptContext", "bodyText",
      "payload", "token", "secret", "credential", "authorization"
    )) { throw "private evidence contains forbidden field $($property.Name)" }
    Assert-MetadataOnlyValue $property.Value
  }
}

function Assert-FreshCrossGroupEvidence {
  param(
    [Parameter(Mandatory)][object]$Evidence,
    [Parameter(Mandatory)][string]$ExpectedStage,
    [Parameter(Mandatory)][string]$ExpectedCommitSha,
    [Parameter(Mandatory)][string]$ExpectedImageDigest,
    [Parameter(Mandatory)][DateTimeOffset]$NotBefore,
    [DateTimeOffset]$NotAfter = [DateTimeOffset]::MaxValue
  )
  Assert-MetadataOnlyValue $Evidence
  if ([string](Get-RequiredProperty $Evidence "stage") -cne $ExpectedStage) { throw "evidence stage mismatch" }
  if ([string](Get-RequiredProperty $Evidence "approvedCommitSha") -cne $ExpectedCommitSha) { throw "evidence SHA mismatch" }
  if ([string](Get-RequiredProperty $Evidence "approvedImageDigest") -cne $ExpectedImageDigest) { throw "evidence image mismatch" }
  $recordedValue = Get-RequiredProperty $Evidence "recordedAt"
  $recordedAt = if ($recordedValue -is [DateTimeOffset]) {
    [DateTimeOffset]$recordedValue
  } elseif ($recordedValue -is [DateTime]) {
    [DateTimeOffset]$recordedValue
  } else {
    $parsed = [DateTimeOffset]::MinValue
    if (-not [DateTimeOffset]::TryParse(
      [string]$recordedValue,
      [Globalization.CultureInfo]::InvariantCulture,
      [Globalization.DateTimeStyles]::RoundtripKind,
      [ref]$parsed
    )) { throw "evidence timestamp is invalid" }
    $parsed
  }
  if ($recordedAt -lt $NotBefore -or $recordedAt -gt $NotAfter) { throw "evidence timestamp is outside the stage window" }
}

function Assert-ExactInteger {
  param([object]$Value, [int64]$Expected, [string]$Label)
  if ($null -eq $Value -or [int64]$Value -ne $Expected) {
    throw "$Label must equal $Expected"
  }
}

function Assert-CrossGroupDrainCounts {
  param([object]$Facts)
  foreach ($name in @("pendingCount", "deadLetterCount", "unresolvedDeliveryCount")) {
    Assert-ExactInteger -Value $Facts.$name -Expected 0 -Label $name
  }
}

function Assert-CrossGroupGrantFacts {
  param([object]$Facts)
  $versions = Get-CrossGroupGrantVersionSequence ([int64]$Facts.baselineVersion)
  Assert-ExactInteger $Facts.preGrant.granteeTraceCount 0 "pre-grant grantee trace count"
  Assert-ExactInteger $Facts.preGrant.controlTraceCount 0 "pre-grant control trace count"
  Assert-ExactInteger $Facts.preGrant.promptGrantCount 0 "pre-grant prompt grant count"
  if ([string]$Facts.grant.state -cne "active") { throw "grant must be active" }
  Assert-ExactInteger $Facts.grant.version $versions.initial "initial grant version"
  Assert-ExactInteger $Facts.grant.grantedEventCount 1 "initial granted event count"
  Assert-ExactInteger $Facts.grantee.deliveryCount 1 "grantee delivery count"
  Assert-ExactInteger $Facts.grantee.traceCount 1 "grantee trace count"
  Assert-ExactInteger $Facts.grantee.exactGrantBindingCount 1 "exact grant binding count"
  Assert-ExactInteger $Facts.control.traceCount 0 "control trace count"
  Assert-ExactInteger $Facts.control.sourceDisclosureCount 0 "control disclosure count"
  Assert-ExactInteger $Facts.revocation.preparedCount 1 "prepared revocation count"
  Assert-ExactInteger $Facts.revocation.version $versions.revoked "revoked grant version"
  Assert-ExactInteger $Facts.revocation.permissionBlockedCount 1 "permission blocked count"
  Assert-ExactInteger $Facts.revocation.sendStartedCount 0 "revoked send-start count"
  Assert-ExactInteger $Facts.revocation.sentCount 0 "revoked sent count"
  Assert-ExactInteger $Facts.regrant.version $versions.regranted "regrant version"
  Assert-ExactInteger $Facts.regrant.grantedEventCount 1 "regrant event count"
  Assert-ExactInteger $Facts.regrant.replayEventDelta 0 "regrant replay event delta"
  Assert-ExactInteger $Facts.regrant.deliveryCount 1 "regrant delivery count"
  Assert-ExactInteger $Facts.race.safeOutcomeCount 1 "safe race outcome count"
  Assert-ExactInteger $Facts.race.sendAfterRevokeCount 0 "send-after-revoke count"
}

function Assert-CrossGroupRollbackAttestation {
  param([object]$Facts)
  if ([bool]$Facts.caddyRunning) { throw "Caddy must be stopped" }
  if ([bool]$Facts.globalEnabled -or [bool]$Facts.desiredGlobalEnabled) {
    throw "global runtime must be durably disabled"
  }
  if (-not [bool]$Facts.capabilitiesDisabled) { throw "every runtime capability must be disabled" }
  if ([int64]$Facts.disabledGroupCount -lt 3) { throw "all three groups must be disabled" }
  Assert-ExactInteger $Facts.activePilotGrantCount 0 "active pilot grant count"
  Assert-CrossGroupDrainCounts $Facts
  if ([string]$Facts.mutableFingerprintBefore -cne [string]$Facts.mutableFingerprintAfter) {
    throw "mutable state fingerprint changed during quiet window"
  }
  if ([int64]$Facts.appendOnlyEventCountAfter -lt [int64]$Facts.appendOnlyEventCountBefore) {
    throw "append-only facts decreased"
  }
}

function Get-RequiredEnvironmentValue {
  param([string]$Name)
  $value = [Environment]::GetEnvironmentVariable($Name)
  if ([string]::IsNullOrWhiteSpace($value)) { throw "$Name is required" }
  return $value.Trim()
}

function Get-CrossGroupContext {
  $context = [ordered]@{
    ApprovedCommitSha = Get-RequiredEnvironmentValue "APPROVED_COMMIT_SHA"
    ApprovedCiRunId = Get-RequiredEnvironmentValue "APPROVED_CI_RUN_ID"
    ApprovedImageDigest = Get-RequiredEnvironmentValue "IRIS_APPROVED_IMAGE_DIGEST"
    SourceGroupId = Get-RequiredEnvironmentValue "SOURCE_GROUP_ID"
    GranteeGroupId = Get-RequiredEnvironmentValue "GRANTEE_GROUP_ID"
    ControlGroupId = Get-RequiredEnvironmentValue "CONTROL_GROUP_ID"
    DocumentSourceId = Get-RequiredEnvironmentValue "DOCUMENT_SOURCE_ID"
    GroupInventoryPath = Get-RequiredEnvironmentValue "IRIS_BOT_GROUP_INVENTORY_PATH"
    EvidencePath = Get-RequiredEnvironmentValue "IRIS_CROSS_GROUP_EVIDENCE_PATH"
  }
  if ($context.ApprovedCommitSha -cnotmatch '^[0-9a-f]{40}$') { throw "approved SHA is invalid" }
  if ($context.ApprovedCiRunId -cnotmatch '^[1-9][0-9]{0,19}$') { throw "approved CI run ID is invalid" }
  if ($context.ApprovedImageDigest -cnotmatch '^sha256:[0-9a-f]{64}$') { throw "approved image ID is invalid" }
  foreach ($name in @("SourceGroupId", "GranteeGroupId", "ControlGroupId", "DocumentSourceId")) {
    $null = Assert-Reference -Name $name -Value ([string]$context[$name])
  }
  $groups = @($context.SourceGroupId, $context.GranteeGroupId, $context.ControlGroupId)
  if (@($groups | Select-Object -Unique).Count -ne 3) { throw "three distinct group IDs required" }
  foreach ($path in @($context.GroupInventoryPath, $context.EvidencePath)) {
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw "required private file is missing" }
  }
  return $context
}

function Invoke-Compose {
  param([string[]]$Arguments)
  & docker compose --env-file .env.pilot --file deploy/pilot/docker-compose.yml @Arguments
  if ($LASTEXITCODE -ne 0) { throw "Compose command failed" }
}

function Test-CrossGroupCaddyRunning {
  $services = @(& docker compose --env-file .env.pilot --file deploy/pilot/docker-compose.yml `
    ps --status running --services caddy)
  if ($LASTEXITCODE -ne 0) { throw "Caddy runtime status is unavailable" }
  return @($services | Where-Object {
    -not [string]::IsNullOrWhiteSpace([string]$_)
  }).Count -ne 0
}

function Get-PilotEnv {
  $entries = Get-Content -LiteralPath .env.pilot | Where-Object { $_ -match '^[A-Za-z_][A-Za-z0-9_]*=' }
  return ConvertFrom-StringData ($entries -join "`n")
}

function Get-PilotEnvValue {
  param([string]$Name)
  $matches = @(Get-Content -LiteralPath .env.pilot | Where-Object { $_ -match ("^{0}=(.*)$" -f [regex]::Escape($Name)) })
  if ($matches.Count -ne 1) { throw ".env.pilot must contain exactly one $Name assignment" }
  return ($matches[0] -replace ("^{0}=" -f [regex]::Escape($Name)), "")
}

function Invoke-PilotSql {
  param([Parameter(Mandatory)][string]$Sql)
  $pilotEnv = Get-PilotEnv
  $lines = @(& docker compose --env-file .env.pilot --file deploy/pilot/docker-compose.yml exec -T postgres `
    psql -v ON_ERROR_STOP=1 -U $pilotEnv.POSTGRES_USER -d $pilotEnv.POSTGRES_DB -Atc $Sql)
  if ($LASTEXITCODE -ne 0) { throw "PostgreSQL metadata query failed" }
  return $lines
}

function Invoke-JsonSql {
  param([Parameter(Mandatory)][string]$Sql)
  $lines = @(Invoke-PilotSql -Sql $Sql)
  if ($lines.Count -ne 1) { throw "PostgreSQL metadata query did not return one row" }
  return ($lines[0] | ConvertFrom-Json)
}

function Get-CrossGroupGrantVersionSequence {
  param([int64]$BaselineVersion)
  if ($BaselineVersion -lt 0 -or $BaselineVersion -gt ([int64]::MaxValue - 3)) {
    throw "grant baseline version is invalid"
  }
  return [pscustomobject]@{
    initial = $BaselineVersion + 1
    revoked = $BaselineVersion + 2
    regranted = $BaselineVersion + 3
  }
}

function Get-CrossGroupGrantBaseline {
  param([object]$Context)
  $facts = Invoke-JsonSql -Sql @"
SELECT json_build_object(
  'projectionCount',(SELECT count(*) FROM document_source_group_grants
    WHERE document_source_id='$($Context.DocumentSourceId)' AND grantee_group_id='$($Context.GranteeGroupId)'),
  'grantId',(SELECT id FROM document_source_group_grants
    WHERE document_source_id='$($Context.DocumentSourceId)' AND grantee_group_id='$($Context.GranteeGroupId)'),
  'grantorGroupId',(SELECT grantor_group_id FROM document_source_group_grants
    WHERE document_source_id='$($Context.DocumentSourceId)' AND grantee_group_id='$($Context.GranteeGroupId)'),
  'state',(SELECT state FROM document_source_group_grants
    WHERE document_source_id='$($Context.DocumentSourceId)' AND grantee_group_id='$($Context.GranteeGroupId)'),
  'version',(SELECT version FROM document_source_group_grants
    WHERE document_source_id='$($Context.DocumentSourceId)' AND grantee_group_id='$($Context.GranteeGroupId)')
);
"@
  $projectionCount = [int64]$facts.projectionCount
  if ($projectionCount -eq 0) {
    return [pscustomobject]@{ grantId = $null; version = [int64]0 }
  }
  if ($projectionCount -ne 1 -or [string]$facts.state -cne "revoked" -or
      [string]$facts.grantorGroupId -cne [string]$Context.SourceGroupId -or
      [int64]$facts.version -lt 1) {
    throw "existing pilot grant projection is not one exact revoked baseline"
  }
  return [pscustomobject]@{
    grantId = Assert-Reference -Name "baseline grant" -Value ([string]$facts.grantId)
    version = [int64]$facts.version
  }
}

function Assert-ReviewedBuild {
  param([object]$Context)
  if ((git rev-parse HEAD).Trim() -cne $Context.ApprovedCommitSha) { throw "reviewed SHA mismatch" }
  if (@(git status --porcelain --untracked-files=all).Count -ne 0) { throw "reviewed checkout is not clean" }
  $ci = (& gh run view $Context.ApprovedCiRunId --json headSha,conclusion,status,jobs) | ConvertFrom-Json
  if ($LASTEXITCODE -ne 0 -or $ci.headSha -cne $Context.ApprovedCommitSha -or
      $ci.status -cne "completed" -or $ci.conclusion -cne "success") {
    throw "approved CI run is not successful for the reviewed SHA"
  }
  $postgresSteps = @($ci.jobs | ForEach-Object { @($_.steps) } |
    Where-Object { $_.name -ceq "Test Postgres integrations" })
  if ($postgresSteps.Count -ne 1 -or $postgresSteps[0].conclusion -cne "success") {
    throw "Test Postgres integrations did not pass"
  }
  if ((Get-PilotEnvValue "IRIS_IMAGE_TAG") -cne $Context.ApprovedCommitSha) { throw "IRIS_IMAGE_TAG mismatch" }
  $imageId = (& docker image inspect "iris-core:$($Context.ApprovedCommitSha)" --format '{{.Id}}').Trim()
  if ($LASTEXITCODE -ne 0 -or $imageId -cne $Context.ApprovedImageDigest) {
    throw "Core image does not match ApprovedImageDigest"
  }
  $coreContainerId = (& docker compose --env-file .env.pilot --file deploy/pilot/docker-compose.yml ps -q core).Trim()
  if ($LASTEXITCODE -ne 0 -or $coreContainerId -cnotmatch '^[0-9a-f]{12,64}$') { throw "running Core container is missing" }
  $runningImageId = (& docker inspect $coreContainerId --format '{{.Image}}').Trim()
  if ($LASTEXITCODE -ne 0 -or $runningImageId -cne $Context.ApprovedImageDigest) {
    throw "running Core container image differs from the approved image"
  }
}

function Invoke-CoreJson {
  param([string]$Method, [string]$Path, [object]$Body)
  $token = Get-RequiredEnvironmentValue "IRIS_INTERNAL_API_TOKEN"
  $headers = @{
    Authorization = "Bearer $token"
    "x-iris-operator" = "cross-group-document-grant-acceptance"
  }
  $arguments = @{ Method = $Method; Uri = "http://127.0.0.1:3000$Path"; Headers = $headers }
  if ($null -ne $Body) {
    $arguments.ContentType = "application/json"
    $arguments.Body = $Body | ConvertTo-Json -Compress -Depth 8
  }
  return Invoke-RestMethod @arguments
}

function Assert-DurableMutation {
  param([object]$Result, [string]$Label)
  if ((Get-RequiredProperty $Result "durable") -ne $true) { throw "$Label was not durable" }
}

function Assert-CrossGroupLiveActivation {
  param([object]$Runtime, [object]$Context, [string[]]$KnownGroupIds)
  if ($Runtime.persistence.storage -cne "postgres" -or $Runtime.persistence.ok -ne $true) {
    throw "runtime policy is not durably readable"
  }
  if ($Runtime.globalEnabled -ne $true -or $Runtime.desiredGlobalEnabled -ne $true -or
      $Runtime.activationRequired -ne $false) {
    throw "runtime global activation is not live"
  }
  $selected = @($Context.SourceGroupId, $Context.GranteeGroupId, $Context.ControlGroupId)
  if (@($selected | Where-Object { $Runtime.disabledGroupIds -contains $_ }).Count -ne 0) {
    throw "selected group is disabled"
  }
  if (@($KnownGroupIds | Where-Object { $_ -notin $selected -and $Runtime.disabledGroupIds -notcontains $_ }).Count -ne 0) {
    throw "non-selected known group is enabled"
  }
  foreach ($name in @("readGroupContext", "replyWhenMentioned", "readGroupDocuments", "retrieveKnowledgeBase")) {
    if ($Runtime.capabilities.$name -ne $true) { throw "$name is not live" }
  }
  foreach ($name in @("proactiveSpeech", "generateKnowledgeDrafts", "writeKnowledgeBase", "callExternalTools")) {
    if ($Runtime.capabilities.$name -ne $false) { throw "$name exceeds the answer-only window" }
  }
}

function Start-CrossGroupIngressWindow {
  param([object]$Context, [string[]]$KnownGroupIds)
  Invoke-Compose @("up", "--detach", "--wait", "--wait-timeout", "120", "--no-deps", "caddy")
  $runtime = Invoke-CoreJson "GET" "/internal/runtime-control/status" $null
  Assert-CrossGroupLiveActivation -Runtime $runtime -Context $Context -KnownGroupIds $KnownGroupIds
}

function Get-MetadataArtifact {
  param([string]$Path)
  $artifact = Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json
  Assert-MetadataOnlyValue $artifact
  return $artifact
}

function Get-FreshCrossGroupEvidence {
  param([object]$Context, [string]$Stage, [DateTimeOffset]$NotBefore)
  if ((Read-Host "Complete $Stage, overwrite the private evidence file, then type PASS").Trim() -cne "PASS") {
    throw "$Stage was not confirmed"
  }
  $evidence = Get-MetadataArtifact $Context.EvidencePath
  Assert-FreshCrossGroupEvidence -Evidence $evidence -ExpectedStage $Stage `
    -ExpectedCommitSha $Context.ApprovedCommitSha `
    -ExpectedImageDigest $Context.ApprovedImageDigest -NotBefore $NotBefore `
    -NotAfter ([DateTimeOffset]::UtcNow.AddMinutes(5))
  return $evidence
}

function New-OperationKey {
  return [Guid]::NewGuid().ToString("D")
}

function Assert-CoreQueuesDrained {
  param([object]$Status)
  $counts = @(
    $Status.components.eventWorker.pendingEventCount,
    $Status.components.eventWorker.deadLetterEventCount,
    $Status.components.documentSync.pendingJobCount,
    $Status.components.documentSync.deadLetterJobCount,
    $Status.components.reindex.pendingJobCount,
    $Status.components.reindex.deadLetterJobCount,
    $Status.knowledgeCards.queue.pending,
    $Status.knowledgeCards.queue.processing,
    $Status.knowledgeCards.queue.delayed,
    $Status.knowledgeCards.queue.deadLetter,
    $Status.knowledgeCards.presentations.pending_send,
    $Status.knowledgeCards.presentations.active,
    $Status.knowledgeCards.presentations.send_failed,
    $Status.knowledgeCards.presentations.pendingSend,
    $Status.knowledgeCards.outbox.pending,
    $Status.knowledgeCards.outbox.processing,
    $Status.knowledgeCards.outbox.external_attempting,
    $Status.knowledgeCards.outbox.outcome_unknown,
    $Status.knowledgeCards.outbox.terminalFailed
  )
  if (@($counts | Where-Object { [int64]$_ -ne 0 }).Count -ne 0) {
    throw "a queue, DLQ, presentation, or outbox is not drained"
  }
}

function Assert-AnswerOnlyBaseline {
  $status = Invoke-CoreJson "GET" "/internal/status" $null
  $readiness = Invoke-CoreJson "GET" "/internal/readiness" $null
  if ($status.status -cne "healthy" -or $readiness.ok -ne $true) { throw "private runtime is not healthy" }
  foreach ($name in @("memoryExtraction", "knowledgeConflicts", "actionApprovals", "proactiveSignals")) {
    if ($status.components.$name.enabled -eq $true) { throw "$name must be disabled for answer-only acceptance" }
  }
  if ($status.knowledgeCards.enabled -eq $true) { throw "knowledge cards must be disabled for answer-only acceptance" }
  $environment = Get-PilotEnv
  if ($environment.IRIS_THREAD_EXTRACTION_GROUP_IDS -cne "" -or $environment.IRIS_ACTION_EXTRACTION_GROUP_IDS -cne "") {
    throw "semantic thread/action extraction groups must be empty"
  }
  $grantCheck = @($readiness.checks | Where-Object { $_.id -ceq "documentSourceGroupGrants" })
  if ($grantCheck.Count -ne 1 -or $grantCheck[0].status -cne "pass") {
    throw "cross-group grant readiness is not live and passing"
  }
}

function Get-CrossGroupDrainSnapshot {
  param([object]$Context)
  $status = Invoke-CoreJson "GET" "/internal/status" $null
  Assert-CoreQueuesDrained $status
  $unresolved = [int64](Invoke-PilotSql -Sql @"
SELECT count(*) FROM answer_reply_deliveries
WHERE chat_id IN ('$($Context.SourceGroupId)','$($Context.GranteeGroupId)','$($Context.ControlGroupId)')
  AND (
    state IN ('prepared','sending','reconciliation_required')
    OR (state IN ('permission_blocked','not_sent_reconciled') AND safe_notice_sent_at IS NULL)
  );
"@)
  return [pscustomobject]@{
    pendingCount = 0
    deadLetterCount = 0
    unresolvedDeliveryCount = $unresolved
  }
}

function Wait-CrossGroupDrain {
  param([object]$Context, [int]$Attempts = 60, [int]$DelayMilliseconds = 500)
  $lastError = $null
  for ($attempt = 1; $attempt -le $Attempts; $attempt++) {
    try {
      $snapshot = Get-CrossGroupDrainSnapshot $Context
      Assert-CrossGroupDrainCounts $snapshot
      return $snapshot
    } catch {
      $lastError = $_
      if ($attempt -lt $Attempts) { Start-Sleep -Milliseconds $DelayMilliseconds }
    }
  }
  throw "cross-group queues did not drain within the bounded wait: $($lastError.Exception.Message)"
}

function Get-KnownGroupIds {
  param([object]$Context)
  $inventory = @(Get-Content -LiteralPath $Context.GroupInventoryPath |
    ForEach-Object { $_.Trim() } | Where-Object { $_ -ne "" } |
    ForEach-Object { Assert-Reference -Name "inventory group" -Value $_ })
  $database = @(Invoke-PilotSql -Sql "SELECT group_id FROM (SELECT chat_id AS group_id FROM conversation_messages UNION SELECT group_id FROM group_memories UNION SELECT group_id FROM knowledge_conflict_candidates UNION SELECT grantor_group_id FROM document_source_group_grants UNION SELECT grantee_group_id FROM document_source_group_grants) groups WHERE group_id IS NOT NULL AND group_id <> '' ORDER BY group_id" |
    ForEach-Object { Assert-Reference -Name "database group" -Value $_.Trim() })
  foreach ($selected in @($Context.SourceGroupId, $Context.GranteeGroupId, $Context.ControlGroupId)) {
    if ($inventory -notcontains $selected) { throw "selected group is absent from current bot inventory" }
  }
  return @($inventory + $database | Sort-Object -Unique)
}

function Assert-SourceBinding {
  param([object]$Context)
  $facts = Invoke-JsonSql -Sql @"
SELECT json_build_object(
  'sourceCount',(SELECT count(*) FROM document_sources WHERE id='$($Context.DocumentSourceId)'
    AND source_type='group_visible_document' AND permission_state IN ('unknown','readable') AND sync_state='synced'
    AND can_use_for_answering=TRUE),
  'sourceEvidenceCount',(SELECT count(*) FROM document_source_evidence WHERE document_source_id='$($Context.DocumentSourceId)'
    AND kind='group_message' AND group_id='$($Context.SourceGroupId)'),
  'unexpectedEvidenceCount',(SELECT count(*) FROM document_source_evidence WHERE document_source_id='$($Context.DocumentSourceId)'
    AND kind='group_message' AND group_id IN ('$($Context.GranteeGroupId)','$($Context.ControlGroupId)')),
  'latestSnapshotCount',(SELECT count(*) FROM document_snapshots snapshot
    WHERE snapshot.id=(SELECT id FROM document_snapshots WHERE document_source_id='$($Context.DocumentSourceId)'
      ORDER BY fetched_at DESC,id ASC LIMIT 1) AND snapshot.fetch_status='succeeded'
      AND snapshot.content_hash ~ '^[0-9a-f]{64}$')
);
"@
  Assert-ExactInteger $facts.sourceCount 1 "source binding count"
  if ([int64]$facts.sourceEvidenceCount -lt 1) { throw "source group evidence is missing" }
  Assert-ExactInteger $facts.unexpectedEvidenceCount 0 "unexpected group evidence count"
  Assert-ExactInteger $facts.latestSnapshotCount 1 "latest snapshot count"
}

function Get-StageObservation {
  param([object]$Evidence, [string]$Name)
  return Get-RequiredProperty (Get-RequiredProperty $Evidence "observations") $Name
}

function Assert-ObservedDisclosure {
  param([object]$Evidence, [string]$Name, [bool]$Expected)
  $actual = Get-StageObservation $Evidence $Name
  if ($actual -isnot [bool] -or [bool]$actual -ne $Expected) { throw "$Name observation mismatch" }
}

function Assert-DenialStage {
  param([object]$Context, [object]$Evidence, [bool]$IncludeControl)
  $granteeMessage = Assert-Reference -Name "grantee message" -Value ([string](Get-StageObservation $Evidence "granteeIncomingMessageId"))
  $controlMessage = if ($IncludeControl) {
    Assert-Reference -Name "control message" -Value ([string](Get-StageObservation $Evidence "controlIncomingMessageId"))
  } else { "__none__" }
  $facts = Invoke-JsonSql -Sql @"
SELECT json_build_object(
  'granteeMessageCount',(SELECT count(*) FROM conversation_messages WHERE provider_message_id='$granteeMessage' AND chat_id='$($Context.GranteeGroupId)'),
  'controlMessageCount',(SELECT count(*) FROM conversation_messages WHERE provider_message_id='$controlMessage' AND chat_id='$($Context.ControlGroupId)'),
  'granteeTraceCount',(SELECT count(*) FROM answer_reply_deliveries delivery JOIN answer_reply_source_traces trace ON trace.delivery_id=delivery.id
    WHERE delivery.incoming_message_id='$granteeMessage' AND delivery.chat_id='$($Context.GranteeGroupId)' AND trace.document_source_id='$($Context.DocumentSourceId)'),
  'controlTraceCount',(SELECT count(*) FROM answer_reply_deliveries delivery JOIN answer_reply_source_traces trace ON trace.delivery_id=delivery.id
    WHERE delivery.incoming_message_id='$controlMessage' AND delivery.chat_id='$($Context.ControlGroupId)' AND trace.document_source_id='$($Context.DocumentSourceId)'),
  'promptGrantCount',(SELECT count(*) FROM answer_reply_deliveries delivery JOIN answer_reply_source_traces trace ON trace.delivery_id=delivery.id
    WHERE delivery.incoming_message_id IN ('$granteeMessage','$controlMessage') AND trace.cross_group_grant_id IS NOT NULL)
);
"@
  Assert-ExactInteger $facts.granteeMessageCount 1 "grantee message count"
  if ($IncludeControl) { Assert-ExactInteger $facts.controlMessageCount 1 "control message count" }
  Assert-ExactInteger $facts.granteeTraceCount 0 "denied grantee trace count"
  Assert-ExactInteger $facts.controlTraceCount 0 "denied control trace count"
  Assert-ExactInteger $facts.promptGrantCount 0 "denied prompt grant count"
  Assert-ObservedDisclosure $Evidence "granteeDisclosedSource" $false
  if ($IncludeControl) { Assert-ObservedDisclosure $Evidence "controlDisclosedSource" $false }
}

function Assert-GrantProjection {
  param([object]$Context, [string]$GrantId, [string]$OperationKey, [int64]$Version, [string]$State, [string]$EventType)
  $facts = Invoke-JsonSql -Sql @"
SELECT json_build_object(
  'projectionCount',(SELECT count(*) FROM document_source_group_grants WHERE id='$GrantId'
    AND document_source_id='$($Context.DocumentSourceId)' AND grantor_group_id='$($Context.SourceGroupId)'
    AND grantee_group_id='$($Context.GranteeGroupId)' AND version=$Version AND state='$State'),
  'eventCount',(SELECT count(*) FROM document_source_group_grant_events WHERE grant_id='$GrantId'
    AND operation_key='$OperationKey' AND to_version=$Version AND event_type='$EventType')
);
"@
  Assert-ExactInteger $facts.projectionCount 1 "grant projection count"
  Assert-ExactInteger $facts.eventCount 1 "grant event count"
}

function Assert-GrantedAnswerStage {
  param([object]$Context, [object]$Evidence, [string]$GrantId, [int64]$GrantVersion)
  $granteeMessage = Assert-Reference -Name "grantee message" -Value ([string](Get-StageObservation $Evidence "granteeIncomingMessageId"))
  $controlMessage = Assert-Reference -Name "control message" -Value ([string](Get-StageObservation $Evidence "controlIncomingMessageId"))
  $facts = Invoke-JsonSql -Sql @"
SELECT json_build_object(
  'granteeMessageCount',(SELECT count(*) FROM conversation_messages WHERE provider_message_id='$granteeMessage' AND chat_id='$($Context.GranteeGroupId)'),
  'controlMessageCount',(SELECT count(*) FROM conversation_messages WHERE provider_message_id='$controlMessage' AND chat_id='$($Context.ControlGroupId)'),
  'deliveryCount',(SELECT count(*) FROM answer_reply_deliveries WHERE incoming_message_id='$granteeMessage' AND chat_id='$($Context.GranteeGroupId)' AND state='sent'),
  'traceCount',(SELECT count(*) FROM answer_reply_deliveries delivery JOIN answer_reply_source_traces trace ON trace.delivery_id=delivery.id
    WHERE delivery.incoming_message_id='$granteeMessage' AND trace.document_source_id='$($Context.DocumentSourceId)'),
  'exactTraceCount',(SELECT count(*) FROM answer_reply_deliveries delivery JOIN answer_reply_source_traces trace ON trace.delivery_id=delivery.id
    WHERE delivery.incoming_message_id='$granteeMessage' AND delivery.chat_id='$($Context.GranteeGroupId)'
      AND trace.document_source_id='$($Context.DocumentSourceId)' AND trace.cross_group_grant_id='$GrantId'
      AND trace.cross_group_grant_version=$GrantVersion AND trace.cross_group_grantor_group_id='$($Context.SourceGroupId)'
      AND trace.cross_group_grantee_group_id='$($Context.GranteeGroupId)'),
  'controlTraceCount',(SELECT count(*) FROM answer_reply_deliveries delivery JOIN answer_reply_source_traces trace ON trace.delivery_id=delivery.id
    WHERE delivery.incoming_message_id='$controlMessage' AND trace.document_source_id='$($Context.DocumentSourceId)')
);
"@
  Assert-ExactInteger $facts.granteeMessageCount 1 "grantee message count"
  Assert-ExactInteger $facts.controlMessageCount 1 "control message count"
  Assert-ExactInteger $facts.deliveryCount 1 "sent grantee delivery count"
  if ([int64]$facts.traceCount -lt 1 -or [int64]$facts.exactTraceCount -ne [int64]$facts.traceCount) {
    throw "grantee source traces are not all exact-grant bound"
  }
  Assert-ExactInteger $facts.controlTraceCount 0 "control trace count"
  Assert-ObservedDisclosure $Evidence "granteeDisclosedSource" $true
  Assert-ObservedDisclosure $Evidence "controlDisclosedSource" $false
}

function Get-AppendOnlyEventCount {
  return [int64](Invoke-PilotSql -Sql "SELECT (SELECT count(*) FROM document_source_group_grant_events) + (SELECT count(*) FROM answer_reply_source_traces) + (SELECT count(*) FROM answer_reply_delivery_events)")
}

function Get-CrossGroupMutableFingerprint {
  param([object]$Context)
  $facts = Invoke-JsonSql -Sql @"
SELECT json_build_object(
  'grants',md5(COALESCE((SELECT string_agg(concat_ws('|',id,state,version,updated_at::text),E'\n' ORDER BY id)
    FROM document_source_group_grants WHERE document_source_id='$($Context.DocumentSourceId)'),'')),
  'deliveries',md5(COALESCE((SELECT string_agg(concat_ws('|',id,state,version,attempt_count,updated_at::text),E'\n' ORDER BY id)
    FROM answer_reply_deliveries WHERE chat_id IN ('$($Context.SourceGroupId)','$($Context.GranteeGroupId)','$($Context.ControlGroupId)')),''))
);
"@
  return ($facts | ConvertTo-Json -Compress)
}

function Invoke-RollbackStep {
  param([scriptblock]$Action, [string]$Label)
  try { & $Action } catch { $script:RollbackErrors += "$Label failed: $($_.Exception.Message)" }
}

function Invoke-CrossGroupDocumentGrantRollback {
  param([object]$Context, [object]$Grant)
  # stop caddy before every rollback mutation
  Invoke-RollbackStep -Label "stop caddy" -Action { Invoke-Compose @("stop", "caddy") }
  if ($null -ne $Grant -and [string]$Grant.state -ceq "active") {
    Invoke-RollbackStep -Label "revoke pilot grant" -Action {
      Invoke-CoreJson "POST" ("/internal/document-sync/sources/" +
        [Uri]::EscapeDataString($Context.DocumentSourceId) + "/group-grants/" +
        [Uri]::EscapeDataString([string]$Grant.id) + "/revoke") @{
          expectedVersion = [int64]$Grant.version
          operationKey = New-OperationKey
        } | Out-Null
    }
  }
  foreach ($groupId in $script:KnownGroupIds) {
    Invoke-RollbackStep -Label "disable group" -Action {
      $result = Invoke-CoreJson "POST" ("/internal/runtime-control/groups/" + [Uri]::EscapeDataString($groupId)) @{ enabled = $false }
      Assert-DurableMutation $result "rollback group disable"
    }
  }
  Invoke-RollbackStep -Label "disable global" -Action {
    Assert-DurableMutation (Invoke-CoreJson "POST" "/internal/runtime-control/global" @{ enabled = $false }) "rollback global disable"
  }
  Invoke-RollbackStep -Label "disable capabilities" -Action {
    $result = Invoke-CoreJson "PATCH" "/internal/runtime-control/capabilities" @{
      readGroupContext = $false
      replyWhenMentioned = $false
      readGroupDocuments = $false
      retrieveKnowledgeBase = $false
      generateKnowledgeDrafts = $false
      proactiveSpeech = $false
      writeKnowledgeBase = $false
      callExternalTools = $false
    }
    Assert-DurableMutation $result "rollback capability disable"
  }
  Invoke-RollbackStep -Label "live rollback attestation" -Action {
    $runtime = Invoke-CoreJson "GET" "/internal/runtime-control/status" $null
    $drain = Wait-CrossGroupDrain $Context
    $fingerprintBefore = Get-CrossGroupMutableFingerprint $Context
    $appendBefore = Get-AppendOnlyEventCount
    Start-Sleep -Seconds 5
    $fingerprintAfter = Get-CrossGroupMutableFingerprint $Context
    $appendAfter = Get-AppendOnlyEventCount
    $activeGrantCount = [int64](Invoke-PilotSql -Sql "SELECT count(*) FROM document_source_group_grants WHERE document_source_id='$($Context.DocumentSourceId)' AND grantee_group_id='$($Context.GranteeGroupId)' AND state='active'")
    $caddyRunning = Test-CrossGroupCaddyRunning
    $disabledCount = @($script:KnownGroupIds | Where-Object { $runtime.disabledGroupIds -contains $_ }).Count
    $capabilityNames = @(
      "readGroupContext", "replyWhenMentioned", "readGroupDocuments", "retrieveKnowledgeBase",
      "proactiveSpeech", "generateKnowledgeDrafts", "writeKnowledgeBase", "callExternalTools"
    )
    $capabilitiesDisabled = @($capabilityNames | Where-Object { $runtime.capabilities.$_ -ne $false }).Count -eq 0
    $facts = [pscustomobject]@{
      caddyRunning = $caddyRunning
      globalEnabled = [bool]$runtime.globalEnabled
      desiredGlobalEnabled = [bool]$runtime.desiredGlobalEnabled
      capabilitiesDisabled = $capabilitiesDisabled
      disabledGroupCount = $disabledCount
      activePilotGrantCount = $activeGrantCount
      pendingCount = $drain.pendingCount
      deadLetterCount = $drain.deadLetterCount
      unresolvedDeliveryCount = $drain.unresolvedDeliveryCount
      mutableFingerprintBefore = $fingerprintBefore
      mutableFingerprintAfter = $fingerprintAfter
      appendOnlyEventCountBefore = $appendBefore
      appendOnlyEventCountAfter = $appendAfter
    }
    Assert-CrossGroupRollbackAttestation $facts
    if ($disabledCount -ne $script:KnownGroupIds.Count) { throw "not every known group is disabled" }
    if ($appendAfter -lt $script:BaselineAppendOnlyEventCount) { throw "append-only baseline decreased" }
  }
}

function Invoke-CrossGroupDocumentGrantAcceptance {
  $context = Get-CrossGroupContext
  $SourceGroupId = $context.SourceGroupId
  $GranteeGroupId = $context.GranteeGroupId
  $ControlGroupId = $context.ControlGroupId
  $grant = $null
  $enableAttempted = $false
  $passed = $false
  try {
    $script:FailedStep = 1
    Invoke-Compose @("stop", "caddy")
    Assert-ReviewedBuild $context
    Invoke-Compose @("config", "--quiet")
    & ./deploy/pilot/backup.sh
    if ($LASTEXITCODE -ne 0) { throw "verified encrypted backup failed" }
    $script:FailedStep = 2
    $enableAttempted = $true
    $script:KnownGroupIds = @(Get-KnownGroupIds $context)
    foreach ($groupId in $script:KnownGroupIds) {
      $result = Invoke-CoreJson "POST" ("/internal/runtime-control/groups/" + [Uri]::EscapeDataString($groupId)) @{ enabled = $false }
      Assert-DurableMutation $result "preflight group disable"
    }
    Assert-DurableMutation (Invoke-CoreJson "POST" "/internal/runtime-control/global" @{ enabled = $false }) "preflight global disable"
    $result = Invoke-CoreJson "PATCH" "/internal/runtime-control/capabilities" @{
      readGroupContext = $false; replyWhenMentioned = $false; readGroupDocuments = $false; retrieveKnowledgeBase = $false
      generateKnowledgeDrafts = $false; proactiveSpeech = $false; writeKnowledgeBase = $false
      callExternalTools = $false
    }
    Assert-DurableMutation $result "preflight capability disable"
    Assert-AnswerOnlyBaseline
    $null = Wait-CrossGroupDrain $context
    Assert-ExactInteger ([int64](Invoke-PilotSql -Sql "SELECT count(*) FROM schema_migrations WHERE name='0051_document_source_group_grants.sql'")) 1 "migration 0051 count"
    Assert-ExactInteger ([int64](Invoke-PilotSql -Sql "SELECT count(*) FROM document_source_group_grants WHERE document_source_id='$($context.DocumentSourceId)' AND grantee_group_id='$($context.GranteeGroupId)' AND state='active'")) 0 "preflight active grant count"
    $script:FailedStep = 3
    Assert-SourceBinding $context
    $grantBaseline = Get-CrossGroupGrantBaseline $context
    $grantVersions = Get-CrossGroupGrantVersionSequence $grantBaseline.version
    $script:BaselineAppendOnlyEventCount = Get-AppendOnlyEventCount

    foreach ($groupId in @($context.SourceGroupId, $context.GranteeGroupId, $context.ControlGroupId)) {
      $result = Invoke-CoreJson "POST" ("/internal/runtime-control/groups/" + [Uri]::EscapeDataString($groupId)) @{ enabled = $true }
      Assert-DurableMutation $result "selected group enable"
    }
    $result = Invoke-CoreJson "PATCH" "/internal/runtime-control/capabilities" @{
      readGroupContext = $true
      replyWhenMentioned = $true
      readGroupDocuments = $true
      retrieveKnowledgeBase = $true
      generateKnowledgeDrafts = $false
      proactiveSpeech = $false
      writeKnowledgeBase = $false
      callExternalTools = $false
    }
    Assert-DurableMutation $result "answer capability enable"
    Assert-DurableMutation (Invoke-CoreJson "POST" "/internal/runtime-control/global" @{ enabled = $true }) "global enable"
    $runtime = Invoke-CoreJson "GET" "/internal/runtime-control/status" $null
    $selected = @($context.SourceGroupId, $context.GranteeGroupId, $context.ControlGroupId)
    if (@($selected | Where-Object { $runtime.disabledGroupIds -contains $_ }).Count -ne 0) { throw "selected group remains disabled" }
    if (@($script:KnownGroupIds | Where-Object { $_ -notin $selected -and $runtime.disabledGroupIds -notcontains $_ }).Count -ne 0) {
      throw "non-selected known group is enabled"
    }

    $script:FailedStep = 4
    $stageStartedAt = [DateTimeOffset]::UtcNow
    Start-CrossGroupIngressWindow -Context $context -KnownGroupIds $script:KnownGroupIds
    $preGrantEvidence = Get-FreshCrossGroupEvidence $context "preGrant" $stageStartedAt
    Invoke-Compose @("stop", "caddy")
    Assert-DenialStage -Context $context -Evidence $preGrantEvidence -IncludeControl $true

    $script:FailedStep = 5
    $initialGrantKey = New-OperationKey
    $created = Invoke-CoreJson "POST" ("/internal/document-sync/sources/" +
      [Uri]::EscapeDataString($context.DocumentSourceId) + "/group-grants") @{
        grantorGroupId = $context.SourceGroupId
        granteeGroupId = $context.GranteeGroupId
        expectedVersion = $grantBaseline.version
        operationKey = $initialGrantKey
      }
    $grant = $created.grant
    if ($created.outcome -cne "applied" -or [int64]$grant.version -ne [int64]$grantVersions.initial -or
        ($null -ne $grantBaseline.grantId -and [string]$grant.id -cne [string]$grantBaseline.grantId)) {
      throw "initial grant was not applied at the next exact version"
    }
    Assert-GrantProjection -Context $context -GrantId $grant.id -OperationKey $initialGrantKey -Version $grantVersions.initial -State "active" -EventType "granted"

    $stageStartedAt = [DateTimeOffset]::UtcNow
    Start-CrossGroupIngressWindow -Context $context -KnownGroupIds $script:KnownGroupIds
    $grantedEvidence = Get-FreshCrossGroupEvidence $context "granted" $stageStartedAt
    Invoke-Compose @("stop", "caddy")
    Assert-GrantedAnswerStage -Context $context -Evidence $grantedEvidence -GrantId $grant.id -GrantVersion $grantVersions.initial

    $script:FailedStep = 6
    $revocationKey = New-OperationKey
    $revoked = Invoke-CoreJson "POST" ("/internal/document-sync/sources/" +
      [Uri]::EscapeDataString($context.DocumentSourceId) + "/group-grants/" +
      [Uri]::EscapeDataString([string]$grant.id) + "/revoke") @{
        expectedVersion = $grantVersions.initial
        operationKey = $revocationKey
      }
    $grant = $revoked.grant
    if ([int64]$grant.version -ne [int64]$grantVersions.revoked -or $grant.state -cne "revoked") { throw "revoke failed" }
    Assert-GrantProjection -Context $context -GrantId $grant.id -OperationKey $revocationKey -Version $grantVersions.revoked -State "revoked" -EventType "revoked"
    $stageStartedAt = [DateTimeOffset]::UtcNow
    Start-CrossGroupIngressWindow -Context $context -KnownGroupIds $script:KnownGroupIds
    $revokedEvidence = Get-FreshCrossGroupEvidence $context "revoked" $stageStartedAt
    Invoke-Compose @("stop", "caddy")
    Assert-DenialStage -Context $context -Evidence $revokedEvidence -IncludeControl $false

    $script:FailedStep = 7
    $regrantKey = New-OperationKey
    $regranted = Invoke-CoreJson "POST" ("/internal/document-sync/sources/" +
      [Uri]::EscapeDataString($context.DocumentSourceId) + "/group-grants") @{
        grantorGroupId = $context.SourceGroupId
        granteeGroupId = $context.GranteeGroupId
        expectedVersion = $grantVersions.revoked
        operationKey = $regrantKey
      }
    $grant = $regranted.grant
    $eventCountBeforeReplay = Get-AppendOnlyEventCount
    $replay = Invoke-CoreJson "POST" ("/internal/document-sync/sources/" +
      [Uri]::EscapeDataString($context.DocumentSourceId) + "/group-grants") @{
        grantorGroupId = $context.SourceGroupId
        granteeGroupId = $context.GranteeGroupId
        expectedVersion = $grantVersions.revoked
        operationKey = $regrantKey
      }
    $eventCountAfterReplay = Get-AppendOnlyEventCount
    if ([int64]$grant.version -ne [int64]$grantVersions.regranted -or $replay.outcome -cne "already_applied" -or $eventCountAfterReplay -ne $eventCountBeforeReplay) {
      throw "regrant replay contract failed"
    }
    Assert-GrantProjection -Context $context -GrantId $grant.id -OperationKey $regrantKey -Version $grantVersions.regranted -State "active" -EventType "granted"
    $stageStartedAt = [DateTimeOffset]::UtcNow
    Start-CrossGroupIngressWindow -Context $context -KnownGroupIds $script:KnownGroupIds
    $regrantedEvidence = Get-FreshCrossGroupEvidence $context "regranted" $stageStartedAt
    Invoke-Compose @("stop", "caddy")
    Assert-GrantedAnswerStage -Context $context -Evidence $regrantedEvidence -GrantId $grant.id -GrantVersion $grantVersions.regranted
    $null = Wait-CrossGroupDrain $context
    $passed = $true
    return [pscustomobject]@{ result = "pass"; failedStep = $null; rollbackRequired = $true }
  } finally {
    $acceptanceFailedStep = $script:FailedStep
    $script:FailedStep = 8
    if ($enableAttempted) {
      Invoke-CrossGroupDocumentGrantRollback -Context $context -Grant $grant
    } else {
      Invoke-Compose @("stop", "caddy")
    }
    $summary = [ordered]@{
      exactCommitSha = $context.ApprovedCommitSha
      ciRunId = $context.ApprovedCiRunId
      imageDigest = $context.ApprovedImageDigest
      result = if ($passed -and $script:RollbackErrors.Count -eq 0) { "pass" } else { "fail" }
      failedStep = if (-not $passed) { $acceptanceFailedStep } elseif ($script:RollbackErrors.Count -ne 0) { 8 } else { $null }
      rollbackPass = ($script:RollbackErrors.Count -eq 0)
      grantId = if ($null -eq $grant) { $null } else { [string]$grant.id }
      grantVersion = if ($null -eq $grant) { $null } else { [int64]$grant.version }
      recordedAt = [DateTimeOffset]::UtcNow.ToString("o")
    }
    if (Test-Path -LiteralPath $context.EvidencePath -PathType Leaf) {
      $summary.evidenceSha256 = (Get-FileHash -LiteralPath $context.EvidencePath -Algorithm SHA256).Hash.ToLowerInvariant()
    }
    $summary | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath "$($context.EvidencePath).summary.json" -Encoding utf8
    if ($script:RollbackErrors.Count -ne 0) {
      throw ("rollback failed: " + ($script:RollbackErrors -join "; "))
    }
  }
}

$acceptanceResult = $null
$acceptanceResult = Invoke-CrossGroupDocumentGrantAcceptance
$acceptanceResult | ConvertTo-Json -Compress
```

At each prompt, overwrite the same private file with this metadata-only shape. Use stage
`preGrant`, `granted`, `revoked`, or `regranted`; `controlIncomingMessageId` and
`controlDisclosedSource` are omitted only for `revoked`. The two successful stages set
`granteeDisclosedSource` to `true`; every denial sets it to `false`.

```json
{
  "stage": "preGrant",
  "recordedAt": "2026-08-18T00:00:00.000Z",
  "approvedCommitSha": "40 lowercase hex characters",
  "approvedImageDigest": "sha256:64 lowercase hex characters",
  "observations": {
    "granteeIncomingMessageId": "metadata-only ID",
    "controlIncomingMessageId": "metadata-only ID",
    "granteeDisclosedSource": false,
    "controlDisclosedSource": false
  }
}
```

The controller deliberately does not delete or truncate durable facts. A failed or incomplete run
remains failed even if rollback succeeds. Do not update requirement coverage until the exact-SHA
CI gate, three-group live observations, race probe, final drain, and rollback attestation all pass.
