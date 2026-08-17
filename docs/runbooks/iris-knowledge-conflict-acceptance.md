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
records real content-free PostgreSQL presentation/outbox, Redis interaction/DLQ, and append-only
fact counts even though card processing is disabled. An unreadable count fails closed. Pending,
active, retry, or processing work, DLQs, outcome-unknown deliveries, and terminal failures must all
be zero.

## Step 4: Establish Controlled Chronology

While the feature is still off, create or select one controlled authorized Wiki source and current
snapshot. In the pilot group, reach a normal incompatible conclusion strictly after the snapshot's
`fetched_at`. Put only IDs, versions, hashes, and timestamps into the private evidence JSON. The
controller proves every production message `sent_at` is later than the exact source and snapshot
times; database ingestion `created_at` is irrelevant. It never reads or emits either
statement.

## Step 5: Enable Only The Pilot Privately

The controller marks enablement attempted before changing `.env.pilot`, keeps Caddy stopped,
enables the conflict/card/approval allowlists for exactly the pilot, recreates Core, enables only
the required read/draft/proactive capabilities, enables the pilot and global runtime durably, then
requires status and readiness to pass before starting Caddy. `writeKnowledgeBase` stays false.

## Step 6: Prove One Exact Scan And Candidate

After one eligible memory is produced, record the scan, memory, candidate, document source,
snapshot, source version, source/fragment timestamps, and content hashes. Record every expected
evidence row using the actual `knowledge_conflict_evidence` columns. The controller requires exact
cardinality and uses bidirectional `EXCEPT ALL`; a duplicate, omitted, or unrelated row fails even
when all five evidence types are present.

## Step 7: Prove The Ordinary Answer Shows Both Sides

Ask an ordinary question about the controlled subject. Record the answer delivery ID and observed
pass/fail facts. The answer must expose the synchronized knowledge side and the newer group side,
label the conflict, and contain no invented winner or resolution. PostgreSQL must bind the answer
delivery to the exact candidate.

## Step 8: Approve Exactly One Delivery

Before operator approval, record that no conflict card was sent. The controller approves the exact
candidate version once with a stable operation key, then requires exactly one sent delivery bound
to the recorded message. Record only the card hash and per-field pass/fail/count facts proving both
sides, material difference, proposed update, uncertainty label, and at least one currently readable
safe link with zero unsafe/denied links; never record rendered card text.

## Step 9: Exercise Callback And Negative Controls

Using the same live window, exercise: current-member draft creation; duplicate delivery and exact
callback replay; a no-conflict memory; a related-subject memory; nonmember denial; and all six
permission/snapshot-change × pre-answer/pre-delivery/pre-callback revocation cases. Each revocation
entry is stage-labelled and binds an exact candidate/version, attempted operation, timestamp,
prospective draft, and callback identity when applicable. Snapshot change additionally requires
the exact superseding event; permission denial requires no candidate mutation. SQL/API facts must
prove zero answer binding or
disclosure, zero post-revocation delivery/message effect, zero applied interaction/draft mutation,
and one rejected callback only for the pre-callback cases.

## Step 10: Prove The Governed Draft And Drain

Require exactly one `knowledge_conflict` draft at `medium` risk, in the existing confirmation,
review, and publication path. This is a governed update draft and does not edit the existing Wiki
page in place. All conflict, answer-delivery, draft-presentation, approval, execution,
reconciliation, publication, and related outbox states must drain; unreadable tables fail closed.
No unknown or terminal failure may remain, and every nonpilot group must retain its Step 3 fact
counts.

## Step 11: Disable Unless A Separate Daily Decision Exists

This runbook always disables at exit. A later daily-pilot decision requires a separately reviewed
record and a new invocation; it is not an option in this acceptance controller. Rollback order is:
stop Caddy; restore the conflict/card/approval flags and allowlists to off/empty; durable-disable all
known groups, global runtime, and read/draft/proactive/write capabilities; recreate Core; re-attest
the exact group inventory plus durable/live global, group, capability, conflict/card/approval, and
empty-allowlist policy; prove every mutable table fingerprint unchanged; and retain all append-only
PostgreSQL facts.

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
$script:BaselineGovernedCounts = $null
$script:BaselineAppendOnlyFacts = $null
$script:BaselineGroupFacts = @{}
$script:RollbackErrors = @()
$script:InitialCurrentBotGroupIds = @()
$script:ChronologyMessageIds = @()
$script:ChronologySourceBinding = ""

function Assert-Reference {
  param([Parameter(Mandatory)][string]$Name, [Parameter(Mandatory)][string]$Value)
  if ($Value -cnotmatch '^[A-Za-z0-9:_-]{1,512}$') { throw "$Name is missing or unsafe" }
  return $Value
}

function Assert-Hash {
  param([Parameter(Mandatory)][string]$Name, [Parameter(Mandatory)][string]$Value)
  if ($Value -cnotmatch '^[0-9a-f]{64}$') { throw "$Name is not a lowercase SHA-256 hash" }
  return $Value
}

function Assert-IsoTimestamp {
  param([Parameter(Mandatory)][string]$Name, [Parameter(Mandatory)][object]$Value)
  if ($Value -is [DateTimeOffset]) { return $Value.ToUniversalTime().ToString('o') }
  if ($Value -is [DateTime]) { return ([DateTimeOffset]$Value).ToUniversalTime().ToString('o') }
  $textValue = [string]$Value
  $parsed = [DateTimeOffset]::MinValue
  if ($textValue -cnotmatch '^\d{4}-\d{2}-\d{2}T' -or -not [DateTimeOffset]::TryParse(
    $textValue,
    [Globalization.CultureInfo]::InvariantCulture,
    [Globalization.DateTimeStyles]::RoundtripKind,
    [ref]$parsed
  )) { throw "$Name is not an ISO timestamp" }
  return $parsed.ToUniversalTime().ToString('o')
}

function Get-RequiredProperty {
  param([Parameter(Mandatory)][object]$Value, [Parameter(Mandatory)][string]$Name)
  if ($Value -is [Collections.IDictionary]) {
    if (-not $Value.Contains($Name)) { throw "Missing required property $Name" }
    return $Value[$Name]
  }
  if ($Value.PSObject.Properties.Name -notcontains $Name) { throw "Missing required property $Name" }
  return $Value.$Name
}

function Assert-ExactStringSet {
  param(
    [Parameter(Mandatory)][object[]]$Expected,
    [Parameter(Mandatory)][object[]]$Actual,
    [Parameter(Mandatory)][string]$Label
  )
  $expectedValues = @($Expected | ForEach-Object { [string]$_ } | Sort-Object -Unique)
  $actualValues = @($Actual | ForEach-Object { [string]$_ } | Sort-Object -Unique)
  if ((@($expectedValues | Where-Object { $_.Length -eq 0 })).Count -ne 0 -or (@($actualValues | Where-Object { $_.Length -eq 0 })).Count -ne 0) { throw "$Label contains an empty value" }
  if ($expectedValues.Count -ne $Expected.Count -or $actualValues.Count -ne $Actual.Count) { throw "$Label contains duplicates" }
  if (($expectedValues -join "`n") -cne ($actualValues -join "`n")) { throw "$Label is not the exact expected set" }
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

function ConvertTo-SqlNullableReference {
  param([string]$Name, [AllowNull()][object]$Value)
  if ($null -eq $Value) { return "NULL::text" }
  $safeValue = Assert-Reference -Name $Name -Value ([string]$Value)
  return "'$safeValue'::text"
}

function ConvertTo-SqlNullableHash {
  param([string]$Name, [AllowNull()][object]$Value)
  if ($null -eq $Value) { return "NULL::text" }
  $safeValue = Assert-Hash -Name $Name -Value ([string]$Value)
  return "'$safeValue'::text"
}

function ConvertTo-SqlNullableTimestamp {
  param([string]$Name, [AllowNull()][object]$Value)
  if ($null -eq $Value) { return "NULL::timestamptz" }
  $safeValue = Assert-IsoTimestamp -Name $Name -Value $Value
  return "'$safeValue'::timestamptz"
}

function Get-ExpectedEvidenceSqlRows {
  param(
    [Parameter(Mandatory)][object[]]$Rows,
    [Parameter(Mandatory)][object]$Evidence,
    [Parameter(Mandatory)][string]$PilotGroupId
  )
  $requiredFields = @(
    'evidenceType','referenceId','groupId','conversationMessageId','groupMemoryId',
    'sourceUpdatedAt','documentSourceId','documentSnapshotId','documentFragmentId',
    'snapshotContentHash','contentHash'
  )
  if ($Rows.Count -lt 5) { throw "Exact evidence rows are incomplete" }
  $pilotMessageIds = @((Get-RequiredProperty $Evidence 'pilotMessageIds') | ForEach-Object {
    Assert-Reference -Name 'pilot message ID' -Value ([string]$_)
  })
  if ($pilotMessageIds.Count -lt 1) { throw "Pilot message evidence is empty" }
  Assert-ExactStringSet -Expected $pilotMessageIds -Actual $pilotMessageIds -Label 'pilot message IDs'
  $memoryId = Assert-Reference -Name 'memoryId' -Value ([string](Get-RequiredProperty $Evidence 'memoryId'))
  $memoryUpdatedAt = Assert-IsoTimestamp -Name 'memoryUpdatedAt' -Value (Get-RequiredProperty $Evidence 'memoryUpdatedAt')
  $documentSourceId = Assert-Reference -Name 'documentSourceId' -Value ([string](Get-RequiredProperty $Evidence 'documentSourceId'))
  $documentSourceUpdatedAt = Assert-IsoTimestamp -Name 'documentSourceUpdatedAt' -Value (Get-RequiredProperty $Evidence 'documentSourceUpdatedAt')
  $snapshotId = Assert-Reference -Name 'snapshotId' -Value ([string](Get-RequiredProperty $Evidence 'snapshotId'))
  $snapshotHash = Assert-Hash -Name 'contentHash' -Value ([string](Get-RequiredProperty $Evidence 'contentHash'))
  $expectedFragments = @((Get-RequiredProperty $Evidence 'documentFragments'))
  if ($expectedFragments.Count -lt 1) { throw "Document fragment evidence is empty" }

  $messageRows = @()
  $fragmentKeys = @()
  $sourceCount = 0
  $snapshotCount = 0
  $memoryCount = 0
  $sqlRows = @()
  foreach ($row in $Rows) {
    $actualFields = @($row.PSObject.Properties.Name | Sort-Object)
    if (($actualFields -join "`n") -cne (@($requiredFields | Sort-Object) -join "`n")) { throw "Evidence row has missing or extra fields" }
    $type = [string]$row.evidenceType
    if ($type -notin @('conversation_message','group_memory','document_source','document_snapshot','document_fragment')) { throw "Evidence type is invalid" }
    $referenceId = Assert-Reference -Name 'evidence referenceId' -Value ([string]$row.referenceId)
    if ($type -eq 'conversation_message') {
      if ([string]$row.groupId -cne $PilotGroupId -or $null -eq $row.conversationMessageId) { throw "Conversation evidence is not pilot-bound" }
      $messageRows += Assert-Reference -Name 'conversationMessageId' -Value ([string]$row.conversationMessageId)
    } elseif ($type -eq 'group_memory') {
      $memoryCount += 1
      if ([string]$row.groupId -cne $PilotGroupId -or [string]$row.groupMemoryId -cne $memoryId -or (Assert-IsoTimestamp -Name 'evidence memory updatedAt' -Value $row.sourceUpdatedAt) -cne $memoryUpdatedAt) { throw "Group-memory evidence is not exact" }
    } elseif ($type -eq 'document_source') {
      $sourceCount += 1
      if ([string]$row.documentSourceId -cne $documentSourceId -or (Assert-IsoTimestamp -Name 'evidence source updatedAt' -Value $row.sourceUpdatedAt) -cne $documentSourceUpdatedAt) { throw "Document-source evidence is not exact" }
    } elseif ($type -eq 'document_snapshot') {
      $snapshotCount += 1
      if ([string]$row.documentSourceId -cne $documentSourceId -or [string]$row.documentSnapshotId -cne $snapshotId -or [string]$row.snapshotContentHash -cne $snapshotHash -or [string]$row.contentHash -cne $snapshotHash) { throw "Document-snapshot evidence is not exact" }
    } else {
      $fragmentId = Assert-Reference -Name 'documentFragmentId' -Value ([string]$row.documentFragmentId)
      $fragmentHash = Assert-Hash -Name 'fragment contentHash' -Value ([string]$row.contentHash)
      if ([string]$row.documentSourceId -cne $documentSourceId -or [string]$row.documentSnapshotId -cne $snapshotId -or [string]$row.snapshotContentHash -cne $snapshotHash) { throw "Document-fragment evidence is not snapshot-bound" }
      $fragmentKeys += "$referenceId`0$fragmentId`0$fragmentHash"
    }
    $sqlValues = @(
      (ConvertTo-SqlNullableReference 'evidenceType' $type),
      (ConvertTo-SqlNullableReference 'referenceId' $referenceId),
      (ConvertTo-SqlNullableReference 'groupId' $row.groupId),
      (ConvertTo-SqlNullableReference 'conversationMessageId' $row.conversationMessageId),
      (ConvertTo-SqlNullableReference 'groupMemoryId' $row.groupMemoryId),
      (ConvertTo-SqlNullableTimestamp 'sourceUpdatedAt' $row.sourceUpdatedAt),
      (ConvertTo-SqlNullableReference 'documentSourceId' $row.documentSourceId),
      (ConvertTo-SqlNullableReference 'documentSnapshotId' $row.documentSnapshotId),
      (ConvertTo-SqlNullableReference 'documentFragmentId' $row.documentFragmentId),
      (ConvertTo-SqlNullableHash 'snapshotContentHash' $row.snapshotContentHash),
      (ConvertTo-SqlNullableHash 'contentHash' $row.contentHash)
    )
    $sqlRows += "(" + ($sqlValues -join ',') + ")"
  }
  Assert-ExactStringSet -Expected $pilotMessageIds -Actual $messageRows -Label 'conversation evidence IDs'
  if ($memoryCount -ne 1 -or $sourceCount -ne 1 -or $snapshotCount -ne 1) { throw "Evidence singleton cardinality is not exact" }
  $expectedFragmentKeys = @($expectedFragments | ForEach-Object {
    $ref = Assert-Reference -Name 'fragment referenceId' -Value ([string](Get-RequiredProperty $_ 'referenceId'))
    $id = Assert-Reference -Name 'fragment ID' -Value ([string](Get-RequiredProperty $_ 'id'))
    $hash = Assert-Hash -Name 'fragment hash' -Value ([string](Get-RequiredProperty $_ 'contentHash'))
    "$ref`0$id`0$hash"
  })
  Assert-ExactStringSet -Expected $expectedFragmentKeys -Actual $fragmentKeys -Label 'fragment evidence identities'
  return $sqlRows
}

function Assert-ExactEvidenceBindingFacts {
  param([Parameter(Mandatory)][object]$Facts)
  foreach ($name in @('scanCount','candidateCount')) {
    if ([long](Get-RequiredProperty $Facts $name) -ne 1) { throw "Exact evidence binding failed at $name" }
  }
  foreach ($name in @('missingEvidenceCount','unexpectedEvidenceCount','duplicateExpectedCount')) {
    if ([long](Get-RequiredProperty $Facts $name) -ne 0) { throw "Exact evidence binding failed at $name" }
  }
  $expectedCount = [long](Get-RequiredProperty $Facts 'expectedEvidenceCount')
  $actualCount = [long](Get-RequiredProperty $Facts 'actualEvidenceCount')
  if ($expectedCount -lt 5 -or $expectedCount -ne $actualCount) { throw "Exact evidence cardinality failed" }
}

function Assert-ApprovedCardProof {
  param(
    [Parameter(Mandatory)][object]$Proof,
    [Parameter(Mandatory)][string]$CandidateId,
    [Parameter(Mandatory)][string]$DeliveryId,
    [Parameter(Mandatory)][string]$MessageId
  )
  if ([string](Get-RequiredProperty $Proof 'candidateId') -cne $CandidateId -or
      [string](Get-RequiredProperty $Proof 'deliveryId') -cne $DeliveryId -or
      [string](Get-RequiredProperty $Proof 'messageId') -cne $MessageId) { throw "Observed card identity is not exact" }
  $null = Assert-Hash -Name 'cardHash' -Value ([string](Get-RequiredProperty $Proof 'cardHash'))
  foreach ($name in @('currentKnowledgeShown','newerGroupConclusionShown','materialDifferenceShown','proposedUpdateShown','uncertaintyLabelShown')) {
    if ((Get-RequiredProperty $Proof $name) -ne $true) { throw "Observed card proof failed at $name" }
  }
  foreach ($name in @('currentKnowledgeEvidenceCount','newerGroupEvidenceCount','safeReadableCurrentLinkCount')) {
    if ([long](Get-RequiredProperty $Proof $name) -lt 1) { throw "Observed card metadata is empty at $name" }
  }
  if ([long](Get-RequiredProperty $Proof 'unsafeOrDeniedLinkCount') -ne 0) { throw "Observed card contains an unsafe or denied link" }
}

function Assert-RevocationFacts {
  param([Parameter(Mandatory)][object[]]$Facts)
  $expectedCases = @(
    'permission/pre_answer','snapshot/pre_answer',
    'permission/pre_delivery','snapshot/pre_delivery',
    'permission/pre_callback','snapshot/pre_callback'
  )
  $actualCases = @()
  foreach ($fact in $Facts) {
    $stage = [string](Get-RequiredProperty $fact 'stage')
    $cause = [string](Get-RequiredProperty $fact 'cause')
    $case = "$cause/$stage"
    $actualCases += $case
    $null = Assert-Reference -Name 'revoked candidate ID' -Value ([string](Get-RequiredProperty $fact 'candidateId'))
    $null = Assert-Reference -Name 'revocation operation key' -Value ([string](Get-RequiredProperty $fact 'operationKey'))
    $null = Assert-IsoTimestamp -Name 'revokedAt' -Value (Get-RequiredProperty $fact 'revokedAt')
    if ([long](Get-RequiredProperty $fact 'exactCandidateCount') -ne 1) { throw "Revocation candidate binding failed at $case" }
    $expectedEventCount = if ($cause -ceq 'snapshot') { 1 } else { 0 }
    if ([long](Get-RequiredProperty $fact 'revocationEventCount') -ne $expectedEventCount) { throw "Revocation event binding failed at $case" }
    if ([long](Get-RequiredProperty $fact 'operationRejectedCount') -ne 1) { throw "Revocation operation was not rejected at $case" }
    $expectedResultCode = if ($cause -ceq 'permission') { 'permission_blocked' } elseif ($stage -ceq 'pre_answer') { 'snapshot_stale' } elseif ($stage -ceq 'pre_delivery') { 'stale_candidate' } else { 'evidence_invalidated' }
    if ([string](Get-RequiredProperty $fact 'operationResultCode') -cne $expectedResultCode) { throw "Revocation API/result code failed at $case" }
    foreach ($name in @('answerConflictBindingCount','answerDisclosureCount','deliveryCreatedCount','sentMessageCount','appliedInteractionCount','draftMutationCount')) {
      if ([long](Get-RequiredProperty $fact $name) -ne 0) { throw "Revocation side effect exists at $case/$name" }
    }
    $expectedCallbackCount = if ($stage -ceq 'pre_callback') { 1 } else { 0 }
    foreach ($name in @('callbackRejectedCount','callbackIdentityCount')) {
      if ([long](Get-RequiredProperty $fact $name) -ne $expectedCallbackCount) { throw "Revocation callback proof failed at $case/$name" }
    }
  }
  Assert-ExactStringSet -Expected $expectedCases -Actual $actualCases -Label 'revocation stage/cause cases'
}

function Assert-MultiMessageChronologyFacts {
  param(
    [Parameter(Mandatory)][object]$Facts,
    [Parameter(Mandatory)][object[]]$ExpectedMessageIds
  )
  $expectedIds = @($ExpectedMessageIds | ForEach-Object { Assert-Reference -Name 'chronology message ID' -Value ([string]$_) })
  $rows = @((Get-RequiredProperty $Facts 'messages'))
  $actualIds = @($rows | ForEach-Object { Assert-Reference -Name 'chronology result message ID' -Value ([string](Get-RequiredProperty $_ 'id')) })
  Assert-ExactStringSet -Expected $expectedIds -Actual $actualIds -Label 'chronology message IDs'
  if ([long](Get-RequiredProperty $Facts 'sourceSnapshotCount') -ne 1) { throw "Exact synchronized source/snapshot binding failed" }
  $sourceUpdatedAt = [DateTimeOffset](Assert-IsoTimestamp -Name 'chronology source updatedAt' -Value (Get-RequiredProperty $Facts 'sourceUpdatedAt'))
  $snapshotFetchedAt = [DateTimeOffset](Assert-IsoTimestamp -Name 'chronology snapshot fetchedAt' -Value (Get-RequiredProperty $Facts 'snapshotFetchedAt'))
  foreach ($row in $rows) {
    $messageId = [string](Get-RequiredProperty $row 'id')
    foreach ($name in @('rowCount','pilotCount','strictlyLaterCount')) {
      if ([long](Get-RequiredProperty $row $name) -ne 1) { throw "Chronology failed for $messageId at $name" }
    }
    $sentAt = [DateTimeOffset](Assert-IsoTimestamp -Name "chronology sentAt for $messageId" -Value (Get-RequiredProperty $row 'sentAt'))
    if ($sentAt -le $sourceUpdatedAt -or $sentAt -le $snapshotFetchedAt) { throw "Production sentAt is not strictly later for $messageId" }
  }
}

function Assert-DrainedDurableStates {
  param([Parameter(Mandatory)][object]$Counts)
  foreach ($name in @(
    'answerPrepared','answerSending','answerReconciliationRequired',
    'draftPresentationUnresolved','draftPresentationActive','draftOutboxUnresolved',
    'actionProposalUnresolved','actionRequirementPending','actionPresentationUnresolved','actionPresentationActive',
    'actionOutboxUnresolved','actionExecutionUnresolved',
    'publishedDraftMissingPublication','succeededProposalMissingPublication',
    'succeededExecutionMissingPublication','publicationBindingMismatch'
  )) {
    if ([long](Get-RequiredProperty $Counts $name) -ne 0) { throw "Durable state is not drained at $name" }
  }
}

function Assert-TerminalGovernedCountsUnchanged {
  param(
    [Parameter(Mandatory)][object]$Before,
    [Parameter(Mandatory)][object]$After
  )
  foreach ($name in @('actionExecutionFailed')) {
    if ([long](Get-RequiredProperty $Before $name) -ne [long](Get-RequiredProperty $After $name)) {
      throw "Terminal governed state changed at $name"
    }
  }
}

function Assert-FingerprintUnchanged {
  param([Parameter(Mandatory)][object]$Before, [Parameter(Mandatory)][object]$After, [Parameter(Mandatory)][string]$Label)
  $beforeJson = $Before | ConvertTo-Json -Compress -Depth 20
  $afterJson = $After | ConvertTo-Json -Compress -Depth 20
  if ($beforeJson -cne $afterJson) { throw "$Label state fingerprint changed" }
}

function Assert-RollbackRuntimeAttestation {
  param(
    [Parameter(Mandatory)][object]$Runtime,
    [Parameter(Mandatory)][object]$Status,
    [Parameter(Mandatory)][object]$Environment,
    [Parameter(Mandatory)][object[]]$ExpectedGroupIds
  )
  if ($Runtime.globalEnabled -ne $false -or $Runtime.desiredGlobalEnabled -ne $false -or $Runtime.activationRequired -ne $false) { throw "Rollback global desired/live policy is not disabled" }
  if ($Runtime.persistence.ok -ne $true -or $Runtime.persistence.storage -cne 'postgres') { throw "Rollback durable policy is not readable from PostgreSQL" }
  Assert-ExactStringSet -Expected $ExpectedGroupIds -Actual @($Runtime.disabledGroupIds) -Label 'rollback disabled groups'
  foreach ($name in @('readGroupDocuments','retrieveKnowledgeBase','proactiveSpeech','generateKnowledgeDrafts','writeKnowledgeBase')) {
    if ((Get-RequiredProperty $Runtime.capabilities $name) -ne $false) { throw "Rollback capability remains enabled at $name" }
  }
  foreach ($name in @('IRIS_KNOWLEDGE_CONFLICT_ENABLED','IRIS_KNOWLEDGE_CARD_ENABLED','IRIS_APPROVAL_ACTIONS_ENABLED')) {
    if ([string](Get-RequiredProperty $Environment $name) -cne 'false') { throw "Rollback feature flag remains enabled at $name" }
  }
  foreach ($name in @('IRIS_KNOWLEDGE_CONFLICT_GROUP_ALLOWLIST','IRIS_KNOWLEDGE_CARD_GROUP_IDS','IRIS_APPROVAL_ACTION_GROUP_IDS')) {
    if ([string](Get-RequiredProperty $Environment $name) -cne '') { throw "Rollback allowlist remains populated at $name" }
  }
  $components = Get-RequiredProperty $Status 'components'
  foreach ($componentName in @('knowledgeConflicts','actionApprovals')) {
    $component = Get-RequiredProperty $components $componentName
    if ((Get-RequiredProperty $component 'ok') -ne $true -or (Get-RequiredProperty $component 'enabled') -ne $false -or (Get-RequiredProperty $component 'running') -ne $false) { throw "Rollback component is not safely disabled at $componentName" }
  }
  $cards = Get-RequiredProperty $Status 'knowledgeCards'
  if ((Get-RequiredProperty $cards 'ok') -ne $true -or (Get-RequiredProperty $cards 'enabled') -ne $false -or (Get-RequiredProperty $cards 'running') -ne $false) { throw "Rollback knowledge-card runtime is not safely disabled" }
  if ([long](Get-RequiredProperty $cards 'enabledGroupCount') -ne 0) { throw "Rollback knowledge-card enabled group count is not zero" }
  $cardQueue = Get-RequiredProperty $cards 'queue'
  foreach ($name in @('pending','processing','delayed','deadLetter')) {
    if ([long](Get-RequiredProperty $cardQueue $name) -ne 0) { throw "Rollback knowledge-card queue is not zero at $name" }
  }
  $cardPresentations = Get-RequiredProperty $cards 'presentations'
  foreach ($name in @('pending_send','active','send_failed','pendingSend')) {
    if ([long](Get-RequiredProperty $cardPresentations $name) -ne 0) { throw "Rollback knowledge-card presentation is not zero at $name" }
  }
  $cardOutbox = Get-RequiredProperty $cards 'outbox'
  foreach ($name in @('pending','processing','external_attempting','outcome_unknown','terminalFailed')) {
    if ([long](Get-RequiredProperty $cardOutbox $name) -ne 0) { throw "Rollback knowledge-card outbox is not zero at $name" }
  }
}

function Assert-DisabledBaselineAttestation {
  param(
    [Parameter(Mandatory)][object]$Runtime,
    [Parameter(Mandatory)][object]$Status,
    [Parameter(Mandatory)][object]$Environment,
    [Parameter(Mandatory)][object[]]$ExpectedGroupIds
  )
  Assert-RollbackRuntimeAttestation -Runtime $Runtime -Status $Status -Environment $Environment -ExpectedGroupIds $ExpectedGroupIds
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

function Get-GovernedUnresolvedCounts {
  param([Parameter(Mandatory)][string]$GroupId)
  $safeGroupId = Assert-Reference -Name 'governed drain group ID' -Value $GroupId
  return Invoke-JsonSql -Sql @"
SELECT json_build_object(
  'answerPrepared', (SELECT count(*) FROM answer_reply_deliveries WHERE state = 'prepared'),
  'answerSending', (SELECT count(*) FROM answer_reply_deliveries WHERE state = 'sending'),
  'answerReconciliationRequired', (SELECT count(*) FROM answer_reply_deliveries WHERE state = 'reconciliation_required'),
  'draftPresentationUnresolved', (SELECT count(*) FROM knowledge_draft_presentations WHERE state IN ('pending_send','active','send_failed')),
  'draftPresentationActive', (SELECT count(*) FROM knowledge_draft_presentations WHERE state = 'active'),
  'draftOutboxUnresolved', (
    SELECT count(*) FROM knowledge_draft_presentation_outbox outbox
    JOIN knowledge_draft_presentations presentation ON presentation.id = outbox.presentation_id
    WHERE outbox.state IN ('pending','processing','external_attempting','failed','outcome_unknown')
      AND presentation.state IN ('pending_send','active','send_failed')
  ),
  'actionProposalUnresolved', (SELECT count(*) FROM action_proposals WHERE status IN ('pending_approval','approved','executing','reconciliation_required')),
  'actionRequirementPending', (SELECT count(*) FROM action_approval_requirements WHERE state = 'pending'),
  'actionPresentationUnresolved', (SELECT count(*) FROM action_approval_presentations WHERE state IN ('pending_send','active','send_failed')),
  'actionPresentationActive', (SELECT count(*) FROM action_approval_presentations WHERE state = 'active'),
  'actionOutboxUnresolved', (
    SELECT count(*) FROM action_approval_presentation_outbox outbox
    JOIN action_approval_presentations presentation ON presentation.id = outbox.presentation_id
    WHERE outbox.state IN ('pending','processing','external_attempting','failed','outcome_unknown')
      AND presentation.state IN ('pending_send','active','send_failed')
  ),
  'actionExecutionUnresolved', (SELECT count(*) FROM action_executions WHERE state IN ('pending','executing','outcome_unknown','reconciliation_required')),
  'actionExecutionFailed', (SELECT count(*) FROM action_executions WHERE state = 'failed'),
  'publishedDraftMissingPublication', (
    SELECT count(*) FROM knowledge_drafts draft
    WHERE draft.origin_kind = 'knowledge_conflict' AND draft.source_group_id = '$safeGroupId'
      AND draft.status = 'published' AND NOT EXISTS (
        SELECT 1 FROM knowledge_publications publication
        JOIN action_proposals proposal ON proposal.id = publication.proposal_id
        JOIN action_executions execution ON execution.id = publication.execution_id
        WHERE publication.draft_id = draft.id
          AND publication.revision_number = draft.current_revision_number
          AND publication.draft_version + 1 = draft.version
          AND publication.published_at = draft.published_at
          AND proposal.subject_id = publication.draft_id
          AND proposal.subject_revision = publication.revision_number
          AND proposal.subject_version = publication.draft_version
          AND proposal.target_policy_id = publication.target_policy_id
          AND proposal.target_policy_version = publication.target_policy_version
          AND proposal.status = 'succeeded'
          AND execution.proposal_id = proposal.id AND execution.state = 'succeeded'
      )
  ),
  'succeededProposalMissingPublication', (
    SELECT count(*) FROM action_proposals proposal
    JOIN knowledge_drafts draft ON draft.id = proposal.subject_id
    WHERE draft.origin_kind = 'knowledge_conflict' AND draft.source_group_id = '$safeGroupId'
      AND proposal.status = 'succeeded' AND NOT EXISTS (
        SELECT 1 FROM knowledge_publications publication
        JOIN action_executions execution ON execution.id = publication.execution_id
        WHERE publication.proposal_id = proposal.id
          AND publication.draft_id = proposal.subject_id
          AND publication.revision_number = proposal.subject_revision
          AND publication.draft_version = proposal.subject_version
          AND publication.target_policy_id = proposal.target_policy_id
          AND publication.target_policy_version = proposal.target_policy_version
          AND execution.proposal_id = proposal.id AND execution.state = 'succeeded'
      )
  ),
  'succeededExecutionMissingPublication', (
    SELECT count(*) FROM action_executions execution
    JOIN action_proposals proposal ON proposal.id = execution.proposal_id
    JOIN knowledge_drafts draft ON draft.id = proposal.subject_id
    WHERE draft.origin_kind = 'knowledge_conflict' AND draft.source_group_id = '$safeGroupId'
      AND execution.state = 'succeeded' AND NOT EXISTS (
        SELECT 1 FROM knowledge_publications publication
        WHERE publication.execution_id = execution.id
          AND publication.proposal_id = proposal.id
          AND publication.draft_id = proposal.subject_id
          AND publication.revision_number = proposal.subject_revision
          AND publication.draft_version = proposal.subject_version
          AND publication.target_policy_id = proposal.target_policy_id
          AND publication.target_policy_version = proposal.target_policy_version
      )
  ),
  'publicationBindingMismatch', (
    SELECT count(*) FROM knowledge_publications publication
    JOIN knowledge_drafts draft ON draft.id = publication.draft_id
    LEFT JOIN action_proposals proposal ON proposal.id = publication.proposal_id
    LEFT JOIN action_executions execution ON execution.id = publication.execution_id
    WHERE draft.origin_kind = 'knowledge_conflict' AND draft.source_group_id = '$safeGroupId'
      AND NOT (
        draft.status = 'published'
        AND publication.revision_number = draft.current_revision_number
        AND publication.draft_version + 1 = draft.version
        AND publication.published_at = draft.published_at
        AND proposal.id IS NOT NULL AND proposal.status = 'succeeded'
        AND proposal.subject_id = publication.draft_id
        AND proposal.subject_revision = publication.revision_number
        AND proposal.subject_version = publication.draft_version
        AND proposal.target_policy_id = publication.target_policy_id
        AND proposal.target_policy_version = publication.target_policy_version
        AND execution.id IS NOT NULL AND execution.state = 'succeeded'
        AND execution.proposal_id = proposal.id
      )
  )
);
"@
}

function Get-DurableActivityFingerprint {
  return Invoke-JsonSql -Sql @"
SELECT json_build_object(
  'scanInbox', (SELECT json_build_object('count',count(*),'stateHash',md5(COALESCE(string_agg(concat_ws('|',id,status,attempt_count,COALESCE(terminal_outcome,''),updated_at::text),E'\n' ORDER BY id),''))) FROM knowledge_conflict_scan_inbox),
  'candidates', (SELECT json_build_object('count',count(*),'stateHash',md5(COALESCE(string_agg(concat_ws('|',id,status,version,updated_at::text),E'\n' ORDER BY id),''))) FROM knowledge_conflict_candidates),
  'conflictOutbox', (SELECT json_build_object('count',count(*),'stateHash',md5(COALESCE(string_agg(concat_ws('|',id,status,retryable,attempt_count,COALESCE(sent_message_id,''),updated_at::text),E'\n' ORDER BY id),''))) FROM knowledge_conflict_delivery_outbox),
  'answerDeliveries', (SELECT json_build_object('count',count(*),'stateHash',md5(COALESCE(string_agg(concat_ws('|',id,state,attempt_count,safe_notice_attempt_count,version,COALESCE(reply_message_id,''),COALESCE(safe_notice_message_id,''),updated_at::text),E'\n' ORDER BY id),''))) FROM answer_reply_deliveries),
  'drafts', (SELECT json_build_object('count',count(*),'stateHash',md5(COALESCE(string_agg(concat_ws('|',id,status,current_revision_number,version,updated_at::text),E'\n' ORDER BY id),''))) FROM knowledge_drafts),
  'draftPresentations', (SELECT json_build_object('count',count(*),'stateHash',md5(COALESCE(string_agg(concat_ws('|',id,state,version,COALESCE(message_id,'')),E'\n' ORDER BY id),''))) FROM knowledge_draft_presentations),
  'draftOutbox', (SELECT json_build_object('count',count(*),'stateHash',md5(COALESCE(string_agg(concat_ws('|',id,state,attempts,updated_at::text),E'\n' ORDER BY id),''))) FROM knowledge_draft_presentation_outbox),
  'actionProposals', (SELECT json_build_object('count',count(*),'stateHash',md5(COALESCE(string_agg(concat_ws('|',id,status,version,updated_at::text),E'\n' ORDER BY id),''))) FROM action_proposals),
  'actionRequirements', (SELECT json_build_object('count',count(*),'stateHash',md5(COALESCE(string_agg(concat_ws('|',id,state,version,updated_at::text),E'\n' ORDER BY id),''))) FROM action_approval_requirements),
  'actionPresentations', (SELECT json_build_object('count',count(*),'stateHash',md5(COALESCE(string_agg(concat_ws('|',id,state,version,COALESCE(message_id,'')),E'\n' ORDER BY id),''))) FROM action_approval_presentations),
  'actionOutbox', (SELECT json_build_object('count',count(*),'stateHash',md5(COALESCE(string_agg(concat_ws('|',id,state,attempts,updated_at::text),E'\n' ORDER BY id),''))) FROM action_approval_presentation_outbox),
  'actionExecutions', (SELECT json_build_object('count',count(*),'stateHash',md5(COALESCE(string_agg(concat_ws('|',id,state,version,updated_at::text),E'\n' ORDER BY id),''))) FROM action_executions)
);
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
  'draftRevisions', (SELECT count(*) FROM knowledge_draft_revisions),
  'draftRevisionEvidence', (SELECT count(*) FROM knowledge_draft_revision_evidence),
  'draftEvents', (SELECT count(*) FROM knowledge_draft_events),
  'draftPresentationEvents', (SELECT count(*) FROM knowledge_draft_presentation_events),
  'draftConfirmations', (SELECT count(*) FROM knowledge_draft_group_confirmations),
  'answerSourceTraces', (SELECT count(*) FROM answer_reply_source_traces),
  'answerDeliveryEvents', (SELECT count(*) FROM answer_reply_delivery_events),
  'actionTargetPolicyOperations', (SELECT count(*) FROM action_target_policy_operations),
  'actionRoleGrantOperations', (SELECT count(*) FROM action_role_grant_operations),
  'actionApprovals', (SELECT count(*) FROM action_approvals),
  'actionEvents', (SELECT count(*) FROM action_events),
  'actionPresentationEvents', (SELECT count(*) FROM action_approval_presentation_events),
  'actionExecutionEvents', (SELECT count(*) FROM action_execution_events),
  'publications', (SELECT count(*) FROM knowledge_publications)
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
  $cards = Get-RequiredProperty $Status 'knowledgeCards'
  $cardQueue = Get-RequiredProperty $cards 'queue'
  $cardPresentations = Get-RequiredProperty $cards 'presentations'
  $cardOutbox = Get-RequiredProperty $cards 'outbox'
  $counts += @(
    (Get-RequiredProperty $cardQueue 'pending'), (Get-RequiredProperty $cardQueue 'processing'),
    (Get-RequiredProperty $cardQueue 'delayed'), (Get-RequiredProperty $cardQueue 'deadLetter'),
    (Get-RequiredProperty $cardPresentations 'pending_send'), (Get-RequiredProperty $cardPresentations 'active'),
    (Get-RequiredProperty $cardPresentations 'send_failed'), (Get-RequiredProperty $cardPresentations 'pendingSend'),
    (Get-RequiredProperty $cardOutbox 'pending'), (Get-RequiredProperty $cardOutbox 'processing'),
    (Get-RequiredProperty $cardOutbox 'external_attempting'), (Get-RequiredProperty $cardOutbox 'outcome_unknown'),
    (Get-RequiredProperty $cardOutbox 'terminalFailed')
  )
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
    $fingerprintBeforeWait = Get-DurableActivityFingerprint
    $factsBeforeWait = Get-AppendOnlyFactCounts
    Start-Sleep -Seconds 5
    $fingerprintAfterWait = Get-DurableActivityFingerprint
    Assert-FingerprintUnchanged -Before $fingerprintBeforeWait -After $fingerprintAfterWait -Label "Disabled durable activity"
    $factsAfterRollback = Get-AppendOnlyFactCounts
    Assert-CountsUnchanged -Before $factsBeforeWait -After $factsAfterRollback -Label "Disabled append-only activity"
    Assert-AppendOnlyFactsPreserved -Before $script:BaselineAppendOnlyFacts -After $factsAfterRollback
    Assert-DrainedActivity (Get-KnowledgeConflictActivityCounts)
    $postRollbackGovernedCounts = Get-GovernedUnresolvedCounts -GroupId $PilotGroupId
    Assert-DrainedDurableStates $postRollbackGovernedCounts
    if ($null -ne $script:BaselineGovernedCounts) {
      Assert-TerminalGovernedCountsUnchanged -Before $script:BaselineGovernedCounts -After $postRollbackGovernedCounts
    }
    $postRollbackCurrentBotGroupIds = @(Get-Content -LiteralPath $BotGroupInventoryPath | ForEach-Object { $_.Trim() } | Where-Object { $_ -ne "" } | ForEach-Object { Assert-Reference -Name "post-rollback inventory group" -Value $_ } | Sort-Object -Unique)
    Assert-ExactStringSet -Expected $script:InitialCurrentBotGroupIds -Actual $postRollbackCurrentBotGroupIds -Label "current bot group inventory"
    $postRollbackDatabaseGroupIds = @(Invoke-PilotSql -Sql "SELECT group_id FROM (SELECT chat_id AS group_id FROM conversation_messages UNION SELECT group_id FROM group_memories UNION SELECT group_id FROM knowledge_conflict_candidates) groups WHERE group_id IS NOT NULL AND group_id <> '' ORDER BY group_id;" | ForEach-Object { Assert-Reference -Name "post-rollback database group" -Value $_.Trim() })
    $postRollbackKnownGroupIds = @($postRollbackCurrentBotGroupIds + $postRollbackDatabaseGroupIds | Sort-Object -Unique)
    Assert-ExactStringSet -Expected $script:KnownGroupIds -Actual $postRollbackKnownGroupIds -Label "known group inventory"
    $runtime = Invoke-RestMethod -Headers $irisHeaders -Uri http://localhost:3000/internal/runtime-control/status
    $status = Invoke-RestMethod -Headers $irisHeaders -Uri http://localhost:3000/internal/status
    Assert-RollbackRuntimeAttestation -Runtime $runtime -Status $status -Environment (Get-PilotEnv) -ExpectedGroupIds $script:KnownGroupIds
  }
}

function Invoke-KnowledgeConflictAcceptance {
  $script:FailedStep = 1
  if ($ApprovedCommitSha -cnotmatch '^[0-9a-f]{40}$') { throw "APPROVED_COMMIT_SHA is invalid" }
  if ($ApprovedImageDigest -cnotmatch '^sha256:[0-9a-f]{64}$') { throw "IRIS_APPROVED_IMAGE_DIGEST is invalid" }
  if (@(git status --porcelain --untracked-files=all).Count -ne 0) { throw "Reviewed checkout is not clean" }
  if ((git rev-parse HEAD).Trim() -cne $ApprovedCommitSha) { throw "Local SHA differs from approved SHA" }
  if ((Get-PilotEnvValue IRIS_IMAGE_TAG) -cne $ApprovedCommitSha) { throw "IRIS_IMAGE_TAG is not the exact approved SHA" }
  $imageId = (& docker image inspect "iris-core:$ApprovedCommitSha" --format '{{.Id}}').Trim()
  if ($LASTEXITCODE -ne 0 -or $imageId -cne $ApprovedImageDigest) { throw "Core image digest differs from the approved digest" }

  $script:FailedStep = 2
  $pilot = Assert-Reference -Name "pilot group" -Value $PilotGroupId
  if (-not (Test-Path -LiteralPath $BotGroupInventoryPath)) { throw "Current bot group inventory is unavailable" }
  $currentBotGroupIds = @(Get-Content -LiteralPath $BotGroupInventoryPath | ForEach-Object { $_.Trim() } | Where-Object { $_ -ne "" } | ForEach-Object { Assert-Reference -Name "inventory group" -Value $_ } | Sort-Object -Unique)
  $script:InitialCurrentBotGroupIds = @($currentBotGroupIds)
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
  foreach ($groupId in $script:KnownGroupIds) {
    Assert-DurableMutation (Invoke-RestMethod -Method Post -Headers $irisHeaders -Uri "http://localhost:3000/internal/runtime-control/groups/$groupId" -ContentType "application/json" -Body '{"enabled":false}') "Preflight group disable"
  }
  Assert-DurableMutation (Invoke-RestMethod -Method Post -Headers $irisHeaders -Uri http://localhost:3000/internal/runtime-control/global -ContentType "application/json" -Body '{"enabled":false}') "Preflight global disable"
  Assert-DurableMutation (Invoke-RestMethod -Method Patch -Headers $irisHeaders -Uri http://localhost:3000/internal/runtime-control/capabilities -ContentType "application/json" -Body '{"readGroupDocuments":false,"retrieveKnowledgeBase":false,"proactiveSpeech":false,"generateKnowledgeDrafts":false,"writeKnowledgeBase":false}') "Preflight capability disable"
  $readiness = Invoke-RestMethod -Headers $irisHeaders -Uri http://localhost:3000/internal/readiness
  $disabledStatus = Invoke-RestMethod -Headers $irisHeaders -Uri http://localhost:3000/internal/status
  $disabledRuntime = Invoke-RestMethod -Headers $irisHeaders -Uri http://localhost:3000/internal/runtime-control/status
  $conflictCheck = @($readiness.checks | Where-Object { $_.id -eq 'knowledgeConflicts' })
  if ($readiness.ok -ne $true -or $disabledStatus.status -cne 'healthy' -or $conflictCheck.Count -ne 1 -or $conflictCheck[0].detail -cne 'Knowledge conflicts are safely disabled.') { throw "Disabled readiness failed" }
  Assert-DisabledBaselineAttestation -Runtime $disabledRuntime -Status $disabledStatus -Environment (Get-PilotEnv) -ExpectedGroupIds $script:KnownGroupIds
  Assert-CoreQueuesDrained $disabledStatus
  $script:BaselineActivity = Get-KnowledgeConflictActivityCounts
  Assert-DrainedActivity $script:BaselineActivity
  $script:BaselineGovernedCounts = Get-GovernedUnresolvedCounts -GroupId $pilot
  Assert-DrainedDurableStates $script:BaselineGovernedCounts
  $script:BaselineAppendOnlyFacts = Get-AppendOnlyFactCounts
  foreach ($groupId in $nonPilotGroupIds) { $script:BaselineGroupFacts[$groupId] = Get-GroupFactCounts $groupId }

  $script:FailedStep = 4
  Confirm-ObservedPass "Create the controlled authorized Wiki snapshot and strictly later incompatible pilot conclusion"
  $fixture = Get-Evidence
  foreach ($field in @('documentSourceId','snapshotId','contentHash','sourceVersion','groupMessageId','memoryId')) {
    $null = Assert-Reference -Name $field -Value ([string]$fixture.$field)
  }
  $null = Assert-Hash -Name 'fixture content hash' -Value ([string]$fixture.contentHash)
  $documentSourceUpdatedAt = Assert-IsoTimestamp -Name 'documentSourceUpdatedAt' -Value (Get-RequiredProperty $fixture 'documentSourceUpdatedAt')
  $snapshotFetchedAt = Assert-IsoTimestamp -Name 'snapshotFetchedAt' -Value (Get-RequiredProperty $fixture 'snapshotFetchedAt')
  $pilotMessageIds = @((Get-RequiredProperty $fixture 'pilotMessageIds') | ForEach-Object { Assert-Reference -Name 'pilot chronology message ID' -Value ([string]$_) })
  Assert-ExactStringSet -Expected $pilotMessageIds -Actual $pilotMessageIds -Label 'pilot chronology message IDs'
  if ($pilotMessageIds.Count -lt 1 -or $pilotMessageIds -notcontains [string]$fixture.groupMessageId) { throw "Candidate source message is absent from exact chronology messages" }
  $expectedMessageValues = @($pilotMessageIds | ForEach-Object { "('$_')" }) -join ",`n    "
  $chronology = Invoke-JsonSql -Sql @"
WITH expected(id) AS (
  VALUES
    $expectedMessageValues
), source_snapshot AS (
  SELECT source.id AS document_source_id, source.updated_at, snapshot.id AS snapshot_id, snapshot.fetched_at
  FROM document_sources source
  JOIN document_snapshots snapshot ON snapshot.document_source_id = source.id
  WHERE source.id = '$($fixture.documentSourceId)'
    AND source.updated_at = '$documentSourceUpdatedAt'::timestamptz
    AND source.permission_state = 'readable' AND source.sync_state = 'synced'
    AND source.can_use_for_knowledge_drafts = TRUE
    AND snapshot.id = '$($fixture.snapshotId)' AND snapshot.fetch_status = 'succeeded'
    AND snapshot.fetched_at = '$snapshotFetchedAt'::timestamptz
    AND snapshot.content_hash = '$($fixture.contentHash)'
    AND snapshot.source_version = '$($fixture.sourceVersion)'
), message_facts AS (
  SELECT expected.id,
    count(message.id) AS row_count,
    count(message.id) FILTER (WHERE message.chat_id = '$pilot') AS pilot_count,
    max(message.sent_at) AS sent_at,
    count(message.id) FILTER (
      WHERE message.chat_id = '$pilot'
        AND EXISTS (
          SELECT 1 FROM source_snapshot
          WHERE message.sent_at > source_snapshot.updated_at
            AND message.sent_at > source_snapshot.fetched_at
        )
    ) AS strictly_later_count
  FROM expected
  LEFT JOIN conversation_messages message ON message.id = expected.id
  GROUP BY expected.id
)
SELECT json_build_object(
  'sourceSnapshotCount', (SELECT count(*) FROM source_snapshot),
  'sourceUpdatedAt', (SELECT updated_at FROM source_snapshot),
  'snapshotFetchedAt', (SELECT fetched_at FROM source_snapshot),
  'messages', (SELECT json_agg(json_build_object(
    'id', id,
    'sentAt', sent_at,
    'rowCount', row_count,
    'pilotCount', pilot_count,
    'strictlyLaterCount', strictly_later_count
  ) ORDER BY id) FROM message_facts)
);
"@
  Assert-MultiMessageChronologyFacts -Facts $chronology -ExpectedMessageIds $pilotMessageIds
  $script:ChronologyMessageIds = @($pilotMessageIds)
  $script:ChronologySourceBinding = @(
    [string]$fixture.documentSourceId,
    $documentSourceUpdatedAt,
    [string]$fixture.snapshotId,
    $snapshotFetchedAt,
    [string]$fixture.contentHash,
    [string]$fixture.sourceVersion
  ) -join "`n"

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
  foreach ($field in @('scanId','candidateId','groupMessageId','memoryId','documentSourceId','snapshotId','sourceVersion')) { $null = Assert-Reference -Name $field -Value ([string](Get-RequiredProperty $evidence $field)) }
  $null = Assert-Hash -Name 'contentHash' -Value ([string](Get-RequiredProperty $evidence 'contentHash'))
  $memoryUpdatedAt = Assert-IsoTimestamp -Name 'memoryUpdatedAt' -Value (Get-RequiredProperty $evidence 'memoryUpdatedAt')
  $documentSourceUpdatedAt = Assert-IsoTimestamp -Name 'documentSourceUpdatedAt' -Value (Get-RequiredProperty $evidence 'documentSourceUpdatedAt')
  $snapshotFetchedAt = Assert-IsoTimestamp -Name 'snapshotFetchedAt' -Value (Get-RequiredProperty $evidence 'snapshotFetchedAt')
  $pilotMessageIds = @((Get-RequiredProperty $evidence 'pilotMessageIds') | ForEach-Object { Assert-Reference -Name 'candidate pilot message ID' -Value ([string]$_) })
  Assert-ExactStringSet -Expected $script:ChronologyMessageIds -Actual $pilotMessageIds -Label 'candidate chronology message IDs'
  $candidateSourceBinding = @(
    [string]$evidence.documentSourceId,
    $documentSourceUpdatedAt,
    [string]$evidence.snapshotId,
    $snapshotFetchedAt,
    [string]$evidence.contentHash,
    [string]$evidence.sourceVersion
  ) -join "`n"
  if ($candidateSourceBinding -cne $script:ChronologySourceBinding) { throw "Candidate source/snapshot binding changed after chronology proof" }
  if ($pilotMessageIds -notcontains [string]$evidence.groupMessageId) { throw "Candidate source message is absent from recorded pilot message IDs" }
  $expectedEvidenceRows = @((Get-RequiredProperty $evidence 'exactEvidenceRows'))
  $expectedEvidenceSqlRows = @(Get-ExpectedEvidenceSqlRows -Rows $expectedEvidenceRows -Evidence $evidence -PilotGroupId $pilot)
  $expectedEvidenceValues = $expectedEvidenceSqlRows -join ",`n    "
  $binding = Invoke-JsonSql -Sql @"
WITH expected(
  evidence_type, reference_id, group_id, conversation_message_id, group_memory_id,
  source_updated_at, document_source_id, document_snapshot_id, document_fragment_id,
  snapshot_content_hash, content_hash
) AS (
  VALUES
    $expectedEvidenceValues
), actual AS (
  SELECT evidence_type, reference_id, group_id, conversation_message_id, group_memory_id,
    source_updated_at, document_source_id, document_snapshot_id, document_fragment_id,
    snapshot_content_hash, content_hash
  FROM knowledge_conflict_evidence
  WHERE candidate_id = '$($evidence.candidateId)'
)
SELECT json_build_object(
  'scanCount', (SELECT count(*) FROM knowledge_conflict_scan_inbox WHERE id='$($evidence.scanId)' AND group_id='$pilot' AND group_memory_id='$($evidence.memoryId)' AND memory_updated_at='$memoryUpdatedAt'::timestamptz AND status='completed' AND terminal_outcome='conflict'),
  'candidateCount', (SELECT count(*) FROM knowledge_conflict_candidates WHERE id='$($evidence.candidateId)' AND group_id='$pilot' AND group_memory_id='$($evidence.memoryId)' AND memory_updated_at='$memoryUpdatedAt'::timestamptz AND source_message_id='$($evidence.groupMessageId)' AND target_document_source_id='$($evidence.documentSourceId)' AND target_source_updated_at='$documentSourceUpdatedAt'::timestamptz AND target_snapshot_id='$($evidence.snapshotId)' AND target_content_hash='$($evidence.contentHash)' AND target_source_version='$($evidence.sourceVersion)'),
  'expectedEvidenceCount', (SELECT count(*) FROM expected),
  'actualEvidenceCount', (SELECT count(*) FROM actual),
  'missingEvidenceCount', (SELECT count(*) FROM (SELECT * FROM expected EXCEPT ALL SELECT * FROM actual) missing),
  'unexpectedEvidenceCount', (SELECT count(*) FROM (SELECT * FROM actual EXCEPT ALL SELECT * FROM expected) unexpected),
  'duplicateExpectedCount', (SELECT count(*) FROM expected) - (SELECT count(*) FROM (SELECT DISTINCT * FROM expected) unique_expected)
);
"@
  Assert-ExactEvidenceBindingFacts $binding

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
  foreach ($field in @('deliveryId','cardMessageId')) { $null = Assert-Reference -Name $field -Value ([string](Get-RequiredProperty $evidence $field)) }
  $approvedCard = Get-RequiredProperty $evidence 'approvedCard'
  Assert-ApprovedCardProof -Proof $approvedCard -CandidateId ([string]$evidence.candidateId) -DeliveryId ([string]$evidence.deliveryId) -MessageId ([string]$evidence.cardMessageId)
  $deliveryBinding = Invoke-JsonSql -Sql @"
SELECT json_build_object(
  'deliveryCount', (SELECT count(*) FROM knowledge_conflict_delivery_outbox WHERE id='$($evidence.deliveryId)' AND candidate_id='$($evidence.candidateId)' AND group_id='$pilot' AND status='sent' AND sent_message_id='$($evidence.cardMessageId)'),
  'readableSourceCount', (SELECT count(*) FROM document_sources WHERE id='$($evidence.documentSourceId)' AND permission_state='readable' AND sync_state='synced' AND can_use_for_knowledge_drafts=TRUE AND source_uri ~ '^https://[^/?#]+([/?#]|$)' AND source_uri !~ '[[:space:][:cntrl:]]' AND position('@' in split_part(source_uri,'/',3))=0)
);
"@
  if ([long]$deliveryBinding.deliveryCount -ne 1 -or [long]$deliveryBinding.readableSourceCount -ne 1 -or [long]$approvedCard.safeReadableCurrentLinkCount -ne [long]$deliveryBinding.readableSourceCount) { throw "Approved card delivery/source binding failed" }

  $script:FailedStep = 9
  Confirm-ObservedPass "Exercise member draft, duplicate delivery/callback, controls, nonmember denial, and permission/snapshot revocation"
  $evidence = Get-Evidence
  foreach ($name in @('duplicateDeliveryNoEffect','duplicateCallbackNoEffect','noConflictControl','relatedSubjectControl','nonmemberDenied')) {
    if ($evidence.observed.$name -ne $true) { throw "Negative/control observation failed at $name" }
  }
  $interaction = Invoke-JsonSql -Sql "SELECT json_build_object('draftInteractions',count(*) FILTER (WHERE action='create_draft' AND result='applied'),'distinctDrafts',count(DISTINCT draft_id)) FROM knowledge_conflict_interactions WHERE candidate_id='$($evidence.candidateId)';"
  if ([long]$interaction.draftInteractions -ne 1 -or [long]$interaction.distinctDrafts -ne 1) { throw "Draft callback was not exactly-once" }
  foreach ($field in @('noConflictMemoryId','relatedSubjectMemoryId')) { $null = Assert-Reference -Name $field -Value ([string]$evidence.$field) }
  $controls = Invoke-JsonSql -Sql "SELECT json_build_object('noConflictScans',(SELECT count(*) FROM knowledge_conflict_scan_inbox WHERE group_id='$pilot' AND group_memory_id='$($evidence.noConflictMemoryId)' AND terminal_outcome='no_conflict'),'noConflictCandidates',(SELECT count(*) FROM knowledge_conflict_candidates WHERE group_memory_id='$($evidence.noConflictMemoryId)'),'relatedScans',(SELECT count(*) FROM knowledge_conflict_scan_inbox WHERE group_id='$pilot' AND group_memory_id='$($evidence.relatedSubjectMemoryId)' AND terminal_outcome IN ('no_conflict','insufficient_evidence')),'relatedCandidates',(SELECT count(*) FROM knowledge_conflict_candidates WHERE group_memory_id='$($evidence.relatedSubjectMemoryId)'));"
  if ([long]$controls.noConflictScans -ne 1 -or [long]$controls.noConflictCandidates -ne 0 -or [long]$controls.relatedScans -ne 1 -or [long]$controls.relatedCandidates -ne 0) { throw "No-conflict or related-subject control facts failed" }

  $revocationFacts = @()
  foreach ($scenario in @((Get-RequiredProperty $evidence 'revocations'))) {
    $stage = [string](Get-RequiredProperty $scenario 'stage')
    $cause = [string](Get-RequiredProperty $scenario 'cause')
    if ($stage -notin @('pre_answer','pre_delivery','pre_callback') -or $cause -notin @('permission','snapshot')) { throw "Revocation stage/cause is invalid" }
    $candidateId = Assert-Reference -Name 'revoked candidate ID' -Value ([string](Get-RequiredProperty $scenario 'candidateId'))
    $operationKey = Assert-Reference -Name 'revocation operation key' -Value ([string](Get-RequiredProperty $scenario 'operationKey'))
    $draftId = Assert-Reference -Name 'revocation draft ID' -Value ([string](Get-RequiredProperty $scenario 'draftId'))
    $revokedAt = Assert-IsoTimestamp -Name 'revokedAt' -Value (Get-RequiredProperty $scenario 'revokedAt')
    $candidateVersionBefore = [long](Get-RequiredProperty $scenario 'candidateVersionBeforeRevocation')
    $candidateVersionAfter = [long](Get-RequiredProperty $scenario 'candidateVersionAfterRevocation')
    if ($candidateVersionBefore -lt 1 -or $candidateVersionAfter -lt $candidateVersionBefore -or ($cause -ceq 'snapshot' -and $candidateVersionAfter -ne $candidateVersionBefore + 1) -or ($cause -ceq 'permission' -and $candidateVersionAfter -ne $candidateVersionBefore)) { throw "Revocation candidate versions are invalid" }
    $operationRejectedCount = [long](Get-RequiredProperty $scenario 'operationRejectedCount')
    $operationResultCode = Assert-Reference -Name 'revocation result code' -Value ([string](Get-RequiredProperty $scenario 'operationResultCode'))
    $callbackRejectedCount = [long](Get-RequiredProperty $scenario 'callbackRejectedCount')
    if ($stage -ceq 'pre_callback') {
      $callbackKey = Assert-Reference -Name 'revoked callback key' -Value ([string](Get-RequiredProperty $scenario 'callbackKey'))
      $callbackEventId = Assert-Reference -Name 'revoked callback event ID' -Value ([string](Get-RequiredProperty $scenario 'callbackEventId'))
      $callbackMessageId = Assert-Reference -Name 'revoked callback message ID' -Value ([string](Get-RequiredProperty $scenario 'callbackMessageId'))
      $callbackIdentityPredicate = "callback_key='$callbackKey' AND event_id='$callbackEventId' AND message_id='$callbackMessageId' AND candidate_id='$candidateId' AND candidate_version=$candidateVersionBefore AND group_id='$pilot'"
      $deliveryCreatedPredicate = "candidate_id='$candidateId' AND created_at >= '$revokedAt'::timestamptz"
      $sentMessagePredicate = "candidate_id='$candidateId' AND sent_message_id IS NOT NULL AND updated_at >= '$revokedAt'::timestamptz"
    } else {
      $callbackIdentityPredicate = "candidate_id='$candidateId' AND received_at >= '$revokedAt'::timestamptz"
      $deliveryCreatedPredicate = "candidate_id='$candidateId'"
      $sentMessagePredicate = "candidate_id='$candidateId' AND sent_message_id IS NOT NULL"
    }
    $revocationFacts += Invoke-JsonSql -Sql @"
SELECT json_build_object(
  'stage','$stage',
  'cause','$cause',
  'candidateId','$candidateId',
  'operationKey','$operationKey',
  'revokedAt','$revokedAt',
  'exactCandidateCount',(SELECT count(*) FROM knowledge_conflict_candidates WHERE id='$candidateId' AND group_id='$pilot' AND version=$candidateVersionAfter),
  'revocationEventCount',(SELECT count(*) FROM knowledge_conflict_candidate_events WHERE candidate_id='$candidateId' AND operation_key='$operationKey' AND from_version=$candidateVersionBefore AND to_version=$candidateVersionAfter AND to_status='superseded' AND reason_code='snapshot_stale' AND created_at='$revokedAt'::timestamptz),
  'operationRejectedCount',$operationRejectedCount,
  'operationResultCode','$operationResultCode',
  'answerConflictBindingCount',(SELECT count(*) FROM answer_reply_knowledge_conflicts WHERE candidate_id='$candidateId'),
  'answerDisclosureCount',(SELECT count(*) FROM answer_reply_knowledge_conflicts binding JOIN answer_reply_deliveries delivery ON delivery.id=binding.delivery_id WHERE binding.candidate_id='$candidateId' AND (delivery.state='sent' OR delivery.reply_message_id IS NOT NULL OR delivery.safe_notice_message_id IS NOT NULL)),
  'deliveryCreatedCount',(SELECT count(*) FROM knowledge_conflict_delivery_outbox WHERE $deliveryCreatedPredicate),
  'sentMessageCount',(SELECT count(*) FROM knowledge_conflict_delivery_outbox WHERE $sentMessagePredicate),
  'appliedInteractionCount',(SELECT count(*) FROM knowledge_conflict_interactions WHERE candidate_id='$candidateId' AND result IN ('applied','already_applied')),
  'draftMutationCount',(SELECT count(*) FROM knowledge_drafts WHERE id='$draftId'),
  'callbackRejectedCount',$callbackRejectedCount,
  'callbackIdentityCount',(SELECT count(*) FROM knowledge_conflict_callback_identities WHERE $callbackIdentityPredicate)
);
"@
  }
  Assert-RevocationFacts -Facts $revocationFacts

  $script:FailedStep = 10
  $draft = Invoke-JsonSql -Sql "SELECT json_build_object('count',count(*),'riskCount',count(*) FILTER (WHERE revision.risk_level='medium'),'pathCount',count(*) FILTER (WHERE draft.status IN ('pending_confirmation','pending_review','needs_revision','rejected','published'))) FROM knowledge_drafts draft JOIN knowledge_draft_revisions revision ON revision.draft_id=draft.id AND revision.revision_number=draft.current_revision_number WHERE draft.id='$($evidence.draftId)' AND draft.source_group_id='$pilot' AND draft.origin_kind='knowledge_conflict';"
  if ([long]$draft.count -ne 1 -or [long]$draft.riskCount -ne 1 -or [long]$draft.pathCount -ne 1) { throw "Governed medium-risk update draft path failed" }
  Assert-DrainedActivity (Get-KnowledgeConflictActivityCounts)
  $finalGovernedCounts = Get-GovernedUnresolvedCounts -GroupId $pilot
  Assert-DrainedDurableStates $finalGovernedCounts
  Assert-TerminalGovernedCountsUnchanged -Before $script:BaselineGovernedCounts -After $finalGovernedCounts
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
  "documentSourceUpdatedAt": "2026-01-01T00:00:00.000Z",
  "snapshotId": "snapshot_id",
  "snapshotFetchedAt": "2026-01-01T00:00:00.500Z",
  "contentHash": "0000000000000000000000000000000000000000000000000000000000000000",
  "sourceVersion": "version_id",
  "groupMessageId": "message_c1_id",
  "pilotMessageIds": ["message_c1_id", "message_c2_id"],
  "memoryId": "memory_id",
  "memoryUpdatedAt": "2026-01-01T00:00:01.000Z",
  "scanId": "scan_id",
  "candidateId": "candidate_id",
  "documentFragments": [
    {
      "referenceId": "D1",
      "id": "fragment_id",
      "contentHash": "1111111111111111111111111111111111111111111111111111111111111111"
    }
  ],
  "exactEvidenceRows": [
    {
      "evidenceType": "conversation_message",
      "referenceId": "C1",
      "groupId": "pilot_group_id",
      "conversationMessageId": "message_c1_id",
      "groupMemoryId": null,
      "sourceUpdatedAt": null,
      "documentSourceId": null,
      "documentSnapshotId": null,
      "documentFragmentId": null,
      "snapshotContentHash": null,
      "contentHash": null
    },
    {
      "evidenceType": "conversation_message",
      "referenceId": "C2",
      "groupId": "pilot_group_id",
      "conversationMessageId": "message_c2_id",
      "groupMemoryId": null,
      "sourceUpdatedAt": null,
      "documentSourceId": null,
      "documentSnapshotId": null,
      "documentFragmentId": null,
      "snapshotContentHash": null,
      "contentHash": null
    },
    {
      "evidenceType": "group_memory",
      "referenceId": "M1",
      "groupId": "pilot_group_id",
      "conversationMessageId": null,
      "groupMemoryId": "memory_id",
      "sourceUpdatedAt": "2026-01-01T00:00:01.000Z",
      "documentSourceId": null,
      "documentSnapshotId": null,
      "documentFragmentId": null,
      "snapshotContentHash": null,
      "contentHash": null
    },
    {
      "evidenceType": "document_source",
      "referenceId": "D1",
      "groupId": null,
      "conversationMessageId": null,
      "groupMemoryId": null,
      "sourceUpdatedAt": "2026-01-01T00:00:00.000Z",
      "documentSourceId": "source_id",
      "documentSnapshotId": null,
      "documentFragmentId": null,
      "snapshotContentHash": null,
      "contentHash": null
    },
    {
      "evidenceType": "document_snapshot",
      "referenceId": "D1",
      "groupId": null,
      "conversationMessageId": null,
      "groupMemoryId": null,
      "sourceUpdatedAt": null,
      "documentSourceId": "source_id",
      "documentSnapshotId": "snapshot_id",
      "documentFragmentId": null,
      "snapshotContentHash": "0000000000000000000000000000000000000000000000000000000000000000",
      "contentHash": "0000000000000000000000000000000000000000000000000000000000000000"
    },
    {
      "evidenceType": "document_fragment",
      "referenceId": "D1",
      "groupId": null,
      "conversationMessageId": null,
      "groupMemoryId": null,
      "sourceUpdatedAt": null,
      "documentSourceId": "source_id",
      "documentSnapshotId": "snapshot_id",
      "documentFragmentId": "fragment_id",
      "snapshotContentHash": "0000000000000000000000000000000000000000000000000000000000000000",
      "contentHash": "1111111111111111111111111111111111111111111111111111111111111111"
    }
  ],
  "answerDeliveryId": "answer_delivery_id",
  "deliveryId": "delivery_id",
  "cardMessageId": "card_message_id",
  "approvedCard": {
    "candidateId": "candidate_id",
    "deliveryId": "delivery_id",
    "messageId": "card_message_id",
    "cardHash": "2222222222222222222222222222222222222222222222222222222222222222",
    "currentKnowledgeShown": false,
    "newerGroupConclusionShown": false,
    "materialDifferenceShown": false,
    "proposedUpdateShown": false,
    "uncertaintyLabelShown": false,
    "currentKnowledgeEvidenceCount": 0,
    "newerGroupEvidenceCount": 0,
    "safeReadableCurrentLinkCount": 0,
    "unsafeOrDeniedLinkCount": 0
  },
  "draftId": "draft_id",
  "noConflictMemoryId": "no_conflict_memory_id",
  "relatedSubjectMemoryId": "related_subject_memory_id",
  "revocations": [
    {
      "stage": "pre_answer",
      "cause": "permission",
      "candidateId": "permission_pre_answer_candidate_id",
      "operationKey": "permission_pre_answer_operation_key",
      "draftId": "permission_pre_answer_draft_id",
      "revokedAt": "2026-01-01T00:01:00.000Z",
      "candidateVersionBeforeRevocation": 1,
      "candidateVersionAfterRevocation": 1,
      "operationRejectedCount": 1,
      "operationResultCode": "permission_blocked",
      "callbackRejectedCount": 0
    },
    {
      "stage": "pre_answer",
      "cause": "snapshot",
      "candidateId": "snapshot_pre_answer_candidate_id",
      "operationKey": "snapshot_pre_answer_operation_key",
      "draftId": "snapshot_pre_answer_draft_id",
      "revokedAt": "2026-01-01T00:02:00.000Z",
      "candidateVersionBeforeRevocation": 1,
      "candidateVersionAfterRevocation": 2,
      "operationRejectedCount": 1,
      "operationResultCode": "snapshot_stale",
      "callbackRejectedCount": 0
    },
    {
      "stage": "pre_delivery",
      "cause": "permission",
      "candidateId": "permission_pre_delivery_candidate_id",
      "operationKey": "permission_pre_delivery_operation_key",
      "draftId": "permission_pre_delivery_draft_id",
      "revokedAt": "2026-01-01T00:03:00.000Z",
      "candidateVersionBeforeRevocation": 1,
      "candidateVersionAfterRevocation": 1,
      "operationRejectedCount": 1,
      "operationResultCode": "permission_blocked",
      "callbackRejectedCount": 0
    },
    {
      "stage": "pre_delivery",
      "cause": "snapshot",
      "candidateId": "snapshot_pre_delivery_candidate_id",
      "operationKey": "snapshot_pre_delivery_operation_key",
      "draftId": "snapshot_pre_delivery_draft_id",
      "revokedAt": "2026-01-01T00:04:00.000Z",
      "candidateVersionBeforeRevocation": 1,
      "candidateVersionAfterRevocation": 2,
      "operationRejectedCount": 1,
      "operationResultCode": "stale_candidate",
      "callbackRejectedCount": 0
    },
    {
      "stage": "pre_callback",
      "cause": "permission",
      "candidateId": "permission_pre_callback_candidate_id",
      "operationKey": "permission_pre_callback_operation_key",
      "draftId": "permission_pre_callback_draft_id",
      "revokedAt": "2026-01-01T00:05:00.000Z",
      "candidateVersionBeforeRevocation": 1,
      "candidateVersionAfterRevocation": 1,
      "operationRejectedCount": 1,
      "operationResultCode": "permission_blocked",
      "callbackKey": "permission_pre_callback_key",
      "callbackEventId": "permission_pre_callback_event_id",
      "callbackMessageId": "permission_pre_callback_message_id",
      "callbackRejectedCount": 1
    },
    {
      "stage": "pre_callback",
      "cause": "snapshot",
      "candidateId": "snapshot_pre_callback_candidate_id",
      "operationKey": "snapshot_pre_callback_operation_key",
      "draftId": "snapshot_pre_callback_draft_id",
      "revokedAt": "2026-01-01T00:06:00.000Z",
      "candidateVersionBeforeRevocation": 1,
      "candidateVersionAfterRevocation": 2,
      "operationRejectedCount": 1,
      "operationResultCode": "evidence_invalidated",
      "callbackKey": "snapshot_pre_callback_key",
      "callbackEventId": "snapshot_pre_callback_event_id",
      "callbackMessageId": "snapshot_pre_callback_message_id",
      "callbackRejectedCount": 1
    }
  ],
  "observed": {
    "answerBothSides": false,
    "answerNoResolution": false,
    "noCardBeforeApproval": false,
    "duplicateDeliveryNoEffect": false,
    "duplicateCallbackNoEffect": false,
    "noConflictControl": false,
    "relatedSubjectControl": false,
    "nonmemberDenied": false
  }
}
```

The placeholder JSON is a schema example only. It is not acceptance evidence and contains no real
identifier, content, or credential.
