# Iris Cross-Group Document Grants Acceptance

Status: unexecuted. This controller proves one answer-only cross-group document loop with one
source group, one distinct grantee group, and one distinct control group. It never authorizes
cross-group memory, knowledge drafts, proactive delivery, wildcard grants, or broad rollout.

The controller starts and ends fail-closed. Evidence is private and metadata-only: exact IDs,
versions, hashes, counts, timestamps, and pass/fail facts. Do not record source, prompt, message,
or reply text, callback payloads, credentials, or authorization material.

Required environment inputs are `APPROVED_COMMIT_SHA`, `IRIS_APPROVED_IMAGE_DIGEST`,
`SOURCE_GROUP_ID`, `GRANTEE_GROUP_ID`, `CONTROL_GROUP_ID`, `DOCUMENT_SOURCE_ID`, and
`IRIS_CROSS_GROUP_EVIDENCE_PATH`. The evidence JSON is stored outside the repository with mode
`0600` or the Windows equivalent. The three group IDs must be distinct.

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
Record only source ID, current snapshot ID/hash/version, and timestamps.

## Step 4: Pre-Grant And Control Denial

Enable only the bounded answer path and the three group ingress paths, then start Caddy last. Ask
the same bounded marker question from the grantee and control groups before any grant. Require zero
prompt grant bindings, zero `answer_reply_source_traces` for the pilot source, and zero disclosure
from both groups. Stop Caddy after the two observations.

## Step 5: Exact Grant And Grantee Answer

Create one exact grant through the authenticated internal API with expected version `0`. Require
one active projection at version `1` and one append-only `granted` event. Start Caddy, ask once from
the grantee, then stop Caddy. Require one delivery whose source trace binds the exact grant ID,
version, grantor group, grantee group, source, snapshot, and fragment. The control group remains
denied.

## Step 6: Prepared-Answer Revocation And Begin-Send Race

Use the prepared-answer pause fixture from the reviewed test build. Revoke version `1` before send
resumes. Require `permission_blocked`, zero `send_started`, zero sent reply, and no source
disclosure. Separately run the real-PostgreSQL begin-send/revoke serialization probe. Accept only
send-won-before-revoke or revoke-won-before-send; reject every send-after-revoke result.

## Step 7: Regrant, Replay, And Final Drain

Regrant the revoked row at expected version `2`, requiring active version `3` and exactly one new
`granted` event. Replay the identical operation key and require `already_applied`, event delta zero,
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
shell. The private evidence JSON supplies the human-observed message IDs and the content-free SQL
fact snapshot after each stage.

```powershell
$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

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
  Assert-ExactInteger $Facts.preGrant.granteeTraceCount 0 "pre-grant grantee trace count"
  Assert-ExactInteger $Facts.preGrant.controlTraceCount 0 "pre-grant control trace count"
  Assert-ExactInteger $Facts.preGrant.promptGrantCount 0 "pre-grant prompt grant count"
  if ([string]$Facts.grant.state -cne "active") { throw "grant must be active" }
  Assert-ExactInteger $Facts.grant.version 1 "initial grant version"
  Assert-ExactInteger $Facts.grant.grantedEventCount 1 "initial granted event count"
  Assert-ExactInteger $Facts.grantee.deliveryCount 1 "grantee delivery count"
  Assert-ExactInteger $Facts.grantee.traceCount 1 "grantee trace count"
  Assert-ExactInteger $Facts.grantee.exactGrantBindingCount 1 "exact grant binding count"
  Assert-ExactInteger $Facts.control.traceCount 0 "control trace count"
  Assert-ExactInteger $Facts.control.sourceDisclosureCount 0 "control disclosure count"
  Assert-ExactInteger $Facts.revocation.preparedCount 1 "prepared revocation count"
  Assert-ExactInteger $Facts.revocation.permissionBlockedCount 1 "permission blocked count"
  Assert-ExactInteger $Facts.revocation.sendStartedCount 0 "revoked send-start count"
  Assert-ExactInteger $Facts.revocation.sentCount 0 "revoked sent count"
  Assert-ExactInteger $Facts.regrant.version 3 "regrant version"
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
    ApprovedImageDigest = Get-RequiredEnvironmentValue "IRIS_APPROVED_IMAGE_DIGEST"
    SourceGroupId = Get-RequiredEnvironmentValue "SOURCE_GROUP_ID"
    GranteeGroupId = Get-RequiredEnvironmentValue "GRANTEE_GROUP_ID"
    ControlGroupId = Get-RequiredEnvironmentValue "CONTROL_GROUP_ID"
    DocumentSourceId = Get-RequiredEnvironmentValue "DOCUMENT_SOURCE_ID"
    EvidencePath = Get-RequiredEnvironmentValue "IRIS_CROSS_GROUP_EVIDENCE_PATH"
  }
  $groups = @($context.SourceGroupId, $context.GranteeGroupId, $context.ControlGroupId)
  if (@($groups | Select-Object -Unique).Count -ne 3) { throw "three distinct group IDs required" }
  if (-not (Test-Path -LiteralPath $context.EvidencePath -PathType Leaf)) {
    throw "private evidence file is missing"
  }
  return $context
}

function Invoke-Compose {
  param([string[]]$Arguments)
  & docker compose --env-file .env.pilot --file deploy/pilot/docker-compose.yml @Arguments
  if ($LASTEXITCODE -ne 0) { throw "Compose command failed" }
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

function Get-MetadataArtifact {
  param([string]$Path)
  $artifact = Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json
  foreach ($forbidden in @("sourceText", "messageText", "replyText", "promptContext", "token")) {
    if ($artifact.PSObject.Properties.Name -contains $forbidden) {
      throw "private evidence contains forbidden field $forbidden"
    }
  }
  return $artifact
}

function New-OperationKey {
  return [Guid]::NewGuid().ToString("D")
}

function Get-CrossGroupDrainSnapshot {
  param([object]$Artifact)
  return [pscustomobject]@{
    pendingCount = [int64]$Artifact.rollback.pendingCount
    deadLetterCount = [int64]$Artifact.rollback.deadLetterCount
    unresolvedDeliveryCount = [int64]$Artifact.rollback.unresolvedDeliveryCount
  }
}

function Invoke-CrossGroupDocumentGrantRollback {
  param([object]$Context, [object]$Artifact, [object]$Grant)
  # stop caddy before every rollback mutation
  Invoke-Compose @("stop", "caddy")
  if ($null -ne $Grant -and [string]$Grant.state -ceq "active") {
    try {
      Invoke-CoreJson "POST" ("/internal/document-sync/sources/" +
        [Uri]::EscapeDataString($Context.DocumentSourceId) + "/group-grants/" +
        [Uri]::EscapeDataString([string]$Grant.id) + "/revoke") @{
          expectedVersion = [int64]$Grant.version
          operationKey = New-OperationKey
        } | Out-Null
    } catch {
      $listed = Invoke-CoreJson "GET" ("/internal/document-sync/sources/" +
        [Uri]::EscapeDataString($Context.DocumentSourceId) + "/group-grants?limit=20") $null
      $current = @($listed.grants | Where-Object { $_.id -ceq $Grant.id })
      if ($current.Count -ne 1 -or $current[0].state -cne "revoked") { throw }
    }
  }
  foreach ($groupId in @($Context.SourceGroupId, $Context.GranteeGroupId, $Context.ControlGroupId)) {
    Invoke-CoreJson "POST" ("/internal/runtime-control/groups/" + [Uri]::EscapeDataString($groupId)) @{ enabled = $false } | Out-Null
  }
  Invoke-CoreJson "POST" "/internal/runtime-control/global" @{ enabled = $false } | Out-Null
  Invoke-CoreJson "PATCH" "/internal/runtime-control/capabilities" @{
    replyWhenMentioned = $false
    readGroupDocuments = $false
    retrieveKnowledgeBase = $false
    generateKnowledgeDrafts = $false
    proactiveSpeech = $false
    writeKnowledgeBase = $false
    callExternalTools = $false
  } | Out-Null
  Assert-CrossGroupDrainCounts (Get-CrossGroupDrainSnapshot $Artifact)
  Assert-CrossGroupRollbackAttestation $Artifact.rollback
}

function Invoke-CrossGroupDocumentGrantAcceptance {
  $context = Get-CrossGroupContext
  $SourceGroupId = $context.SourceGroupId
  $GranteeGroupId = $context.GranteeGroupId
  $ControlGroupId = $context.ControlGroupId
  $artifact = Get-MetadataArtifact $context.EvidencePath
  $grant = $null
  $enableAttempted = $false
  try {
    if ((git rev-parse HEAD).Trim() -cne $context.ApprovedCommitSha) { throw "reviewed SHA mismatch" }
    if (@(git status --porcelain --untracked-files=all).Count -ne 0) { throw "reviewed checkout is not clean" }
    Invoke-Compose @("stop", "caddy")
    Invoke-Compose @("config", "--quiet")
    Assert-ExactInteger $artifact.preflight.migration0051Count 1 "migration 0051 count"
    Assert-ExactInteger $artifact.preflight.activePilotGrantCount 0 "preflight active grant count"
    Assert-CrossGroupDrainCounts $artifact.preflight

    $enableAttempted = $true
    foreach ($groupId in @($context.SourceGroupId, $context.GranteeGroupId, $context.ControlGroupId)) {
      Invoke-CoreJson "POST" ("/internal/runtime-control/groups/" + [Uri]::EscapeDataString($groupId)) @{ enabled = $true } | Out-Null
    }
    Invoke-CoreJson "PATCH" "/internal/runtime-control/capabilities" @{
      replyWhenMentioned = $true
      readGroupDocuments = $true
      retrieveKnowledgeBase = $true
      generateKnowledgeDrafts = $false
      proactiveSpeech = $false
      writeKnowledgeBase = $false
      callExternalTools = $false
    } | Out-Null
    Invoke-CoreJson "POST" "/internal/runtime-control/global" @{ enabled = $true } | Out-Null

    Assert-CrossGroupGrantFacts $artifact.facts
    $created = Invoke-CoreJson "POST" ("/internal/document-sync/sources/" +
      [Uri]::EscapeDataString($context.DocumentSourceId) + "/group-grants") @{
        grantorGroupId = $context.SourceGroupId
        granteeGroupId = $context.GranteeGroupId
        expectedVersion = 0
        operationKey = [string]$artifact.operations.initialGrantKey
      }
    $grant = $created.grant
    if ($created.outcome -cne "applied" -or [int64]$grant.version -ne 1) {
      throw "initial grant was not applied at version 1"
    }

    Invoke-Compose @("up", "--detach", "--wait", "--wait-timeout", "120", "caddy")
    Assert-CrossGroupGrantFacts $artifact.facts
    Invoke-Compose @("stop", "caddy")

    $revoked = Invoke-CoreJson "POST" ("/internal/document-sync/sources/" +
      [Uri]::EscapeDataString($context.DocumentSourceId) + "/group-grants/" +
      [Uri]::EscapeDataString([string]$grant.id) + "/revoke") @{
        expectedVersion = 1
        operationKey = [string]$artifact.operations.revocationKey
      }
    $grant = $revoked.grant
    if ([int64]$grant.version -ne 2 -or $grant.state -cne "revoked") { throw "revoke failed" }

    $regranted = Invoke-CoreJson "POST" ("/internal/document-sync/sources/" +
      [Uri]::EscapeDataString($context.DocumentSourceId) + "/group-grants") @{
        grantorGroupId = $context.SourceGroupId
        granteeGroupId = $context.GranteeGroupId
        expectedVersion = 2
        operationKey = [string]$artifact.operations.regrantKey
      }
    $grant = $regranted.grant
    $replay = Invoke-CoreJson "POST" ("/internal/document-sync/sources/" +
      [Uri]::EscapeDataString($context.DocumentSourceId) + "/group-grants") @{
        grantorGroupId = $context.SourceGroupId
        granteeGroupId = $context.GranteeGroupId
        expectedVersion = 2
        operationKey = [string]$artifact.operations.regrantKey
      }
    if ([int64]$grant.version -ne 3 -or $replay.outcome -cne "already_applied") {
      throw "regrant replay contract failed"
    }
    Assert-CrossGroupGrantFacts $artifact.facts
    return [pscustomobject]@{ result = "pass"; failedStep = $null; rollbackRequired = $true }
  } finally {
    if ($enableAttempted) {
      Invoke-CrossGroupDocumentGrantRollback -Context $context -Artifact $artifact -Grant $grant
    } else {
      Invoke-Compose @("stop", "caddy")
    }
  }
}

$acceptanceResult = $null
$acceptanceResult = Invoke-CrossGroupDocumentGrantAcceptance
$acceptanceResult | ConvertTo-Json -Compress
```

The controller deliberately does not delete or truncate durable facts. A failed or incomplete run
remains failed even if rollback succeeds. Do not update requirement coverage until the exact-SHA
CI gate, three-group live observations, race probe, final drain, and rollback attestation all pass.
