# Managed Knowledge Existing-Page Update — Controlled Feishu Pilot

## Status, scope, and privacy

**Local status:** implemented and locally verified. Default deployment is
`IRIS_MANAGED_KNOWLEDGE_UPDATE_ENABLED=false` with an empty
`IRIS_MANAGED_KNOWLEDGE_UPDATE_GROUP_ALLOWLIST`.

**Live result:** **not yet run**. Controlled Feishu acceptance is pending. A local test, process,
or readiness response is not a passed/deployed pilot.

Run only under a written ticket naming one operator, independent approver, one pilot group, rollback
owner, and immutable image digest/tag/source SHA. This runbook does not create credentials, deploy,
or make an external call itself. Never adopt or update legacy, arbitrary, inferred, multi-block, or
rich-content pages. The target and managed control are fresh Iris-created pages with one plain-text
managed block; the arbitrary unmanaged control is selected only and never registered.

Evidence must never contain raw Feishu `node_token`, `obj_token`/document token, `block_id`,
access/client token, body, draft/review body, or raw Feishu error. A safe Wiki URL is the only remote
locator. Prove exact remote identity with internal IDs and SHA-256/operation/request fingerprints.
Raw values used privately for a manual action must not be printed or copied; do not add an extraction
command to manufacture evidence.

Every SQL block is executed only through the deployment's audited read-only `psql` wrapper, with
`psql -X -v ON_ERROR_STOP=1` and the named variables (for example,
`-v managed_page_id="$ManagedPageId"` or `-v proposal_id="$ProposalId"`). The wrapper must use a
read-only database role/transaction; variables are validated internal IDs and are never echoed.

## Evidence record (all fields begin `pending`)

Any pending/missing field blocks `passed`.

| Gate | Content-free record |
| --- | --- |
| Authority | ticket; operator/independent approver; UTC start/finish; immutable image digest/tag/source SHA |
| Preparation | one group internal ID; flag/allowlist/migration-0055/readiness attestations |
| Target/control | internal managed-page ID, safe Wiki URL, state/version, policy version, revision, body hash, node/document/block SHA-256 fingerprints; control neighbor count/type/hash fingerprints |
| Source/snapshot | source/snapshot/observation IDs, source/snapshot hash/version, observed revision/body hash |
| Proposal | before/after count/types, proposal ID/version, target ID/fingerprint/version, reason code |
| Review/approval | attestation ID/proposal-version/content hash/target fingerprint; approval ID/subject revision/version, requirement kind/role-reference/state and satisfied-source metadata |
| Mutation/resync | execution ID/version/state/request fingerprint/request count, before/after revisions/hashes, neighbor fingerprint, resync tuple, retrieval result IDs/hash/version |
| Drain/rollback | every supported queue/DLQ/unresolved count, durable disable acknowledgements, final runtime/readiness, UTC time |

## Shared safe helpers

Set variables only in the private operator environment. They are validated but not printed.

```powershell
$IrisBaseUri = $env:IRIS_PILOT_INTERNAL_BASE_URI
$ApprovedInternalOrigin = $env:IRIS_PILOT_APPROVED_INTERNAL_ORIGIN
$AllowLoopbackHttp = $env:IRIS_PILOT_ALLOW_LOOPBACK_HTTP
$PilotGroupId = $env:IRIS_PILOT_GROUP_ID
$Operator = $env:IRIS_PILOT_OPERATOR
$ChangeTicket = $env:IRIS_PILOT_CHANGE_TICKET
$ApprovedImageDigest = $env:IRIS_PILOT_IMAGE_DIGEST
$InternalToken = $env:IRIS_INTERNAL_API_TOKEN
function Require-PrivateText([object]$value,[string]$label,[int]$min,[int]$max) {
  $text=[string]$value
  if ([string]::IsNullOrWhiteSpace($text) -or $text.Length -lt $min -or $text.Length -gt $max -or $text -match '[\x00-\x1f\x7f]' -or $text -match '\s' -or $text -match '(?i)(pending|change[_-]?me|placeholder|example|dummy|[<>])') { throw "Invalid $label" }
  return $text
}
function Require-Id([object]$value,[string]$label) { $text=Require-PrivateText $value $label 1 512; if ($text -notmatch '^[A-Za-z0-9][A-Za-z0-9._:@/-]*$') { throw "Invalid $label" }; return $text }
function Require-Token([object]$value) { $text=Require-PrivateText $value 'internal bearer token' 8 4096; if ($text -notmatch '^[A-Za-z0-9._~+/-=]+$') { throw 'Invalid internal bearer token' }; return $text }
$AllowLoopbackHttp=if ([string]::IsNullOrWhiteSpace([string]$AllowLoopbackHttp)) { 'false' } else { Require-PrivateText $AllowLoopbackHttp 'loopback HTTP approval' 4 5 }
if ($AllowLoopbackHttp -notin @('true','false')) { throw 'Invalid loopback HTTP approval' }
function ConvertTo-InternalOrigin([object]$value,[string]$label) {
  $text=Require-PrivateText $value $label 12 512
  try { $uri=[uri]$text } catch { throw "Invalid $label" }
  if (-not $uri.IsAbsoluteUri -or $uri.UserInfo -ne '' -or $uri.Query -ne '' -or $uri.Fragment -ne '' -or $uri.AbsolutePath -notin @('','/')) { throw "Invalid $label" }
  $loopback=$uri.Host -in @('localhost','127.0.0.1','::1','[::1]')
  if ($uri.Scheme -ne 'https' -and -not ($uri.Scheme -eq 'http' -and $loopback -and $AllowLoopbackHttp -eq 'true')) { throw 'Bearer destination must be HTTPS or explicitly approved loopback HTTP' }
  return $uri
}
$IrisBaseUri=ConvertTo-InternalOrigin $IrisBaseUri 'internal base URI'; $approved=ConvertTo-InternalOrigin $ApprovedInternalOrigin 'ticket-approved internal origin'
if ($IrisBaseUri.Scheme -ne $approved.Scheme -or $IrisBaseUri.Host -ne $approved.Host -or $IrisBaseUri.Port -ne $approved.Port) { throw 'Internal bearer destination does not match the ticket-approved origin' }
$IrisBaseUri=$IrisBaseUri.GetLeftPart([System.UriPartial]::Authority)
$PilotGroupId=Require-Id $PilotGroupId 'pilot group ID'; $Operator=Require-Id $Operator 'operator'; $ChangeTicket=Require-Id $ChangeTicket 'change ticket'; $InternalToken=Require-Token $InternalToken
if ($ApprovedImageDigest -notmatch '^sha256:[0-9a-f]{64}$') { throw 'Invalid immutable image digest' }
$irisHeaders = @{ authorization = "Bearer $InternalToken"; 'x-iris-operator' = $Operator.Trim() }
function Prop([object]$o,[string]$n,[string]$l) { if ($null -eq $o -or $null -eq $o.PSObject.Properties[$n]) { throw "Missing $l.$n" }; $o.$n }
function Zero([object]$v,[string]$l) { if ($v -isnot [int] -and $v -isnot [long]) { throw "$l is not an integer" }; if ([long]$v -ne 0) { throw "$l is not zero" } }
function Get-InternalUri([string]$path) { if ($path -notmatch '^/[A-Za-z0-9._~!$&''()*+,;=:@/%?&=-]+$' -or $path -match '\.\.') { throw 'Invalid internal route' }; $uri=[uri]($IrisBaseUri+$path); if ($uri.Scheme -ne $approved.Scheme -or $uri.Host -ne $approved.Host -or $uri.Port -ne $approved.Port) { throw 'Blocked unapproved bearer destination' }; return $uri.AbsoluteUri }
function Get-Internal([string]$path) { Invoke-RestMethod -Headers $irisHeaders -Uri (Get-InternalUri $path) -Method Get }
function Confirm-LiveWrite([string]$action) { if ((Read-Host "Type $ChangeTicket to authorize $action against $ApprovedImageDigest") -cne $ChangeTicket) { throw "Human authority gate rejected $action" } }
function Invoke-InternalWrite([ValidateSet('Post','Patch')][string]$method,[string]$path,[object]$body,[string]$label,[scriptblock]$precondition) { Confirm-LiveWrite $label; $current=Get-Internal '/internal/runtime-control/status'; & $precondition $current; Invoke-RestMethod -Headers $irisHeaders -Method $method -ContentType application/json -Uri (Get-InternalUri $path) -Body ($body | ConvertTo-Json -Compress) }
function Durable([object]$r,[bool]$global,[string]$label) { if ($r.ok -ne $true -or $r.durable -ne $true) { throw "$label is not durable" }; $p=Prop $r persistence $label; if ((Prop $p ok "$label.persistence") -ne $true -or (Prop $p storage "$label.persistence") -ne 'postgres') { throw "$label is not PostgreSQL durable" }; if ((Prop $r globalEnabled $label) -ne $global -or (Prop $r desiredGlobalEnabled $label) -ne $global) { throw "$label desired/current state mismatches" } }
function Assert-RuntimeState([object]$s,[bool]$global,[bool]$pilotDisabled,[bool]$writeKnowledgeBase,[bool]$updateManagedKnowledge,[string]$label) { if ((Prop $s ok $label) -ne $true) { throw "$label is not readable" }; $p=Prop $s persistence $label; if ((Prop $p ok "$label.persistence") -ne $true -or (Prop $p storage "$label.persistence") -ne 'postgres') { throw "$label is not PostgreSQL durable" }; if ((Prop $s globalEnabled $label) -ne $global -or (Prop $s desiredGlobalEnabled $label) -ne $global) { throw "$label global desired/current mismatch" }; $groups=@(Prop $s disabledGroupIds $label); if ((($groups -contains $PilotGroupId) -ne $pilotDisabled)) { throw "$label pilot-group state mismatch" }; $caps=Prop $s capabilities $label; if ((Prop $caps writeKnowledgeBase "$label.capabilities") -ne $writeKnowledgeBase -or (Prop $caps updateManagedKnowledge "$label.capabilities") -ne $updateManagedKnowledge) { throw "$label capability state mismatch" } }
function Assert-RuntimeCoherent([object]$s,[string]$label) { if ((Prop $s ok $label) -ne $true) { throw "$label is not readable" }; $p=Prop $s persistence $label; if ((Prop $p ok "$label.persistence") -ne $true -or (Prop $p storage "$label.persistence") -ne 'postgres') { throw "$label is not PostgreSQL durable" }; if ((Prop $s globalEnabled $label) -ne (Prop $s desiredGlobalEnabled $label)) { throw "$label global current/desired mismatch" } }
function Assert-GlobalDisabled([object]$s,[string]$label) { Assert-RuntimeCoherent $s $label; if ((Prop $s globalEnabled $label) -ne $false) { throw "$label global runtime is not disabled" } }
function Assert-PilotGroupShape([object]$s,[string]$label) { $null=@(Prop $s disabledGroupIds $label) }
function Assert-PilotGroupDisabled([object]$s,[string]$label) { Assert-GlobalDisabled $s $label; Assert-PilotGroupShape $s $label; if (-not (@(Prop $s disabledGroupIds $label) -contains $PilotGroupId)) { throw "$label pilot group is not disabled" } }
function Assert-CapabilityShape([object]$s,[string]$label) { $caps=Prop $s capabilities $label; foreach ($name in @('writeKnowledgeBase','updateManagedKnowledge')) { if ((Prop $caps $name "$label.capabilities") -isnot [bool]) { throw "$label capability state is invalid" } } }
function Assert-ManagedDatabaseDrain {
  $hasPrivatePg=(-not [string]::IsNullOrWhiteSpace([string]$env:PGSERVICE)) -or ((-not [string]::IsNullOrWhiteSpace([string]$env:PGHOST)) -and (-not [string]::IsNullOrWhiteSpace([string]$env:PGDATABASE)))
  if (-not $hasPrivatePg) { throw 'Missing private read-only libpq PG* environment for managed drain' }
  try { $psqlCommand=Get-Command -Name 'psql' -CommandType Application -ErrorAction Stop | Select-Object -First 1 } catch { throw 'PostgreSQL client is unavailable for managed drain' }
  if ($null -eq $psqlCommand) { throw 'PostgreSQL client is unavailable for managed drain' }
  $sql="BEGIN READ ONLY; SELECT state, count(*)::bigint FROM knowledge_publication_update_executions WHERE state IN ('claimed','remote_request_dispatched','outcome_unknown','remote_applied','resync_required','reconciliation_required') GROUP BY state ORDER BY state; COMMIT;"
  $global:LASTEXITCODE=$null
  $rows=@(& $psqlCommand -X -v ON_ERROR_STOP=1 -At -F ',' -q -c $sql 2>$null)
  $invocationSucceeded=$?; $psqlExitCode=$global:LASTEXITCODE
  if (-not $invocationSucceeded -or $psqlExitCode -isnot [int] -or $psqlExitCode -ne 0) { throw 'Managed durable-state drain query failed' }
  foreach ($row in $rows) { $parts=([string]$row).Split(',',2); if ($parts.Count -ne 2 -or $parts[0] -notin @('claimed','remote_request_dispatched','outcome_unknown','remote_applied','resync_required','reconciliation_required') -or $parts[1] -notmatch '^[0-9]+$' -or [long]$parts[1] -ne 0) { throw 'Managed durable-state drain is not zero' } }
}
```

Expected: no exception and no secret output. Stop for placeholders, whitespace/control characters,
invalid IDs/tokens, a non-immutable image, or a base URI that is not the exact ticket-approved HTTPS
origin (loopback HTTP additionally requires `IRIS_PILOT_ALLOW_LOOPBACK_HTTP=true`). Bearer credentials can only reach `Get-InternalUri`; every
write uses `Invoke-InternalWrite`, which calls `Confirm-LiveWrite` immediately before dispatch.

## Preparation: keep managed-update deployment disabled

1. Record authority and privately confirm exactly `IRIS_MANAGED_KNOWLEDGE_UPDATE_ENABLED=false` and
   an empty allowlist. Stop for an enabled/multiple-group configuration, missing migration-0055 proof,
   or missing Feishu write/OAuth capability. Do not make a runtime write.

2. While that flag remains disabled, humans use the existing governed publication flow—not an internal
   API—to publish one fresh target and one fresh managed control. Capture only their internal
   managed-page IDs, safe URLs, state/version, positive revision, hash, and fingerprints. Stop if
   either is not newly captured single plain-text managed content. Select the arbitrary unmanaged
   control’s safe URL and baseline structure fingerprint only; never adopt it.

3. Let normal document sync link/index target and control before enablement. Set `$ManagedPageId` to
   the already-recorded internal ID only (not a remote token), then execute this exact **read-only**
   PostgreSQL projection through the deployment’s audited read-only `psql` wrapper. It does not print
   a credential, raw token, or body and never uses `SELECT *`:

   ```powershell
   $ManagedPageId=Require-Id $env:IRIS_PILOT_MANAGED_PAGE_ID 'managed page ID'
   ```

   ```sql
BEGIN READ ONLY;
SELECT p.id AS managed_page_id, p.linked_document_source_id AS source_id, p.state, p.version AS page_version,
       p.current_remote_revision_id AS remote_revision, p.current_body_content_hash AS body_hash,
       o.id AS observation_id, o.document_snapshot_id AS snapshot_id, o.snapshot_content_hash AS snapshot_hash,
       o.observed_remote_revision_id AS observed_revision, o.managed_body_content_hash AS observed_body_hash
FROM managed_knowledge_pages AS p
LEFT JOIN LATERAL (
  SELECT id, document_snapshot_id, snapshot_content_hash, observed_remote_revision_id, managed_body_content_hash
  FROM managed_knowledge_snapshot_observations WHERE managed_page_id = p.id
  ORDER BY observed_at DESC, id DESC LIMIT 1
) AS o ON TRUE WHERE p.id = :'managed_page_id';
COMMIT;
```

   Expected: exactly one content-free target row with source/snapshot and `active` state. Stop for
   absent/ambiguous link, no snapshot, non-active state, or any drain failure below.

## Exact status and drain checks

Run before enablement, immediately before mutation, after each durable transition, and during
rollback. Real shape is `status.components.managedKnowledgeUpdates`; approval-interaction queue is
top-level `status.knowledgeCards.queue`, not a managed-update property.

```powershell
function Assert-ContentFreeDrain([bool]$requireManagedDisabled=$false) {
$readiness = Get-Internal '/internal/readiness'; $status = Get-Internal '/internal/status'
if ($readiness.ok -ne $true -or $status.ok -ne $true -or $status.status -ne 'healthy') { throw 'Readiness/internal status is not healthy' }
$gate=@($readiness.checks | Where-Object { $_.id -eq 'managedKnowledgeUpdates' }); if ($gate.Count -ne 1 -or $gate[0].status -ne 'pass') { throw 'Managed-update readiness is not pass' }
$components=Prop $status components status; $event=Prop $components eventWorker 'status.components'; $sync=Prop $components documentSync 'status.components'; $reindex=Prop $components reindex 'status.components'; $approvals=Prop $components actionApprovals 'status.components'; $managed=Prop $components managedKnowledgeUpdates 'status.components'; $cards=Prop $status knowledgeCards status; $interaction=Prop $cards queue 'status.knowledgeCards'; $outbox=Prop $approvals outbox 'status.components.actionApprovals'
foreach ($c in @($event,$sync,$reindex,$approvals)) { if ($c.ok -ne $true -or $c.enabled -ne $true -or $c.running -ne $true) { throw 'Required worker is not healthy/running' } }
foreach ($x in @(@($event.pendingEventCount,'event.pending'),@($event.deadLetterEventCount,'event.dlq'),@($event.answerReplyUnresolvedCount,'event.unresolved'),@($event.answerReplyPendingSafeNoticeCount,'event.safe_notice'),@($event.answerReplyReconciliationRequiredCount,'event.reconciliation'),@($sync.pendingJobCount,'sync.pending'),@($sync.deadLetterJobCount,'sync.dlq'),@($reindex.pendingJobCount,'reindex.pending'),@($reindex.deadLetterJobCount,'reindex.dlq'))) { Zero $x[0] $x[1] }
foreach ($n in @('pending','processing','delayed','deadLetter')) { Zero (Prop $interaction $n 'knowledgeCards.queue') "interaction.$n" }
foreach ($n in @('pending','processing','external_attempting','outcome_unknown','terminalFailed')) { Zero (Prop $outbox $n 'actionApprovals.outbox') "approvalOutbox.$n" }
if ($managed.enabled -eq $true) {
  if ($managed.ok -ne $true -or $managed.running -ne $true -or $managed.migration0055Applied -ne $true -or (Prop (Prop $managed worker 'managedUpdates') running 'managedUpdates.worker') -ne $true) { throw 'Managed-update worker is not healthy/running' }
  $recon=Prop $managed reconciliation 'status.components.managedKnowledgeUpdates'
  foreach ($n in @('outcomeUnknown','reconciliationRequired')) { Zero (Prop $recon $n 'managedUpdates.reconciliation') "managedUpdates.$n" }
} elseif ($managed.ok -ne $true -or $managed.enabled -ne $false -or $managed.running -ne $false) { throw 'Managed-update feature is neither safely disabled nor healthy' }
if ($requireManagedDisabled -and $managed.enabled -ne $false) { throw 'Managed-update deployment is not disabled for closeout' }
if ($managed.enabled -eq $false) { Assert-ManagedDatabaseDrain }
}
Assert-ContentFreeDrain
```

Expected: every supported count is present and zero. Before deployment enablement, managed updates
must be safely `ok/enabled=false/running=false`; its reconciliation object is intentionally absent,
so `Assert-ManagedDatabaseDrain` executes and parses the durable-state SQL below to supply the
unresolved check. Post-enable additionally requires
managed `ok/enabled/running/migration0055Applied/worker.running=true` and both reconciliation counters
at zero. Stop on a missing field, degraded worker, nonzero count, or failed readiness. There is no unified status counter for every durable
managed state; the helper uses this audited count-only projection (same read-only private `psql`
environment) and stops if it parses any nonzero row. Do not inspect raw Redis payloads.

```sql
BEGIN READ ONLY;
SELECT state, count(*)::bigint AS count
FROM knowledge_publication_update_executions
WHERE state IN ('claimed','remote_request_dispatched','outcome_unknown','remote_applied','resync_required','reconciliation_required')
GROUP BY state ORDER BY state;
COMMIT;
```

## Enable only after preparation is complete

1. Human gate: compare ticket/authority/image digest; verify one `$PilotGroupId`, flag true and
   allowlist exactly that group in the private deployment config, then deploy only the approved
   immutable image using normal change control. There is no runtime API that replaces this deployment
   configuration. Re-run the preceding status check; stop if readiness/migration/worker/drain fails.

2. These are the real runtime routes and payloads. They do not create a proposal, confirmation,
   review, or approval. Each has its human gate, durable response/readback, and rollback below.

   ```powershell
   $r=Invoke-InternalWrite Patch '/internal/runtime-control/capabilities' @{writeKnowledgeBase=$true;updateManagedKnowledge=$true} 'enable managed-update capabilities' { param($s) Assert-RuntimeState $s $false $true $false $false 'Post-confirm capability precondition' }; Durable $r $false 'Capability enable'
   $r=Invoke-InternalWrite Post ('/internal/runtime-control/groups/'+[uri]::EscapeDataString($PilotGroupId)) @{enabled=$true} 'enable one pilot group' { param($s) Assert-RuntimeState $s $false $true $true $true 'Post-confirm group precondition' }; Durable $r $false 'Group enable'
   $r=Invoke-InternalWrite Post '/internal/runtime-control/global' @{enabled=$true} 'enable global runtime' { param($s) Assert-RuntimeState $s $false $false $true $true 'Post-confirm global precondition' }; Durable $r $true 'Global enable'
   $after=Get-Internal '/internal/runtime-control/status'
   Assert-RuntimeState $after $true $false $true $true 'Post-enable readback'
   ```

   Expected order for every capability/group/global write is human ticket entry, immediate status GET,
   stage-specific fail-closed assertion, then dispatch; the durable response/readback is authoritative.
   There remains an unavoidable GET-to-route race, so no stale prompt-time read is accepted. Stop and
   roll back for a non-durable/storage mismatch, unexpected pilot-group state, or capability mismatch.

## Acceptance actions for the already prepared target

Every action requires the human gate, a durable readback, status/drain check, and the listed stop
condition. Preserve facts; a human edit/stale binding/duplicate/unresolved outcome stops the window.
On any stop, make no blind remote retry: enter **Rollback and closeout**. The manual UI steps below
use only the approved deployment/Feishu surfaces; their readbacks are adjacent metadata-only queries.

1. Human gate: the ticket operator and independent approver verify the one-group window, target
   fingerprint, and control fingerprints. An authorized human creates the approved conflicting source
   in the allowlisted group and triggers the existing conflict flow manually, retaining only the
   content-free UI acknowledgement timestamp/operator. Expected durable readback: one update-bound draft for the
   prepared target. Stop if resolution is unavailable, a control is targeted, or it falls back to
   publish-new; roll back without confirmation or mutation.

2. After the manual conflict action returns its internal draft ID, the operator records it in the
   private environment, reinitializes and validates it, then proves zero proposals with this exact
   read-only request/projection. Before a group member manually confirms the exact displayed card,
   record only the content-free UI acknowledgement timestamp/operator. Expected: zero rows; stop
   otherwise and roll back without confirmation. There is no internal confirmation route.

   ```powershell
   $DraftId=Require-Id $env:IRIS_PILOT_DRAFT_ID 'draft ID'
   $beforeProposals=Get-Internal ('/internal/action-proposals?subjectId='+[uri]::EscapeDataString($DraftId)+'&limit=100')
   ```

   ```sql
BEGIN READ ONLY;
SELECT id, action_type, status, version, subject_revision, subject_version
FROM action_proposals WHERE subject_id = :'draft_id' ORDER BY created_at, id;
COMMIT;
```

3. Human gate: the group member rechecks the exact card, target fingerprint, and ticket before using
   Feishu’s normal confirmation control. This is the real confirmation action—never a forged internal
   API call. After confirmation returns the internal proposal ID, the operator records it privately,
   reinitializes and validates it, then immediately repeats the preceding query. Expected durable readback: exactly one
   `update_knowledge_publication`, no `publish_knowledge_draft`. Record proposal ID/version; use
   this read-only request only for its projected managed target/page/execution metadata (safe URL,
   IDs, states, hashes, revision/version, request fingerprint). Stop on a changed
   target fingerprint/version, missing target, extra proposal, or wrong action type; enter rollback.

   ```powershell
   $ProposalId=Require-Id $env:IRIS_PILOT_PROPOSAL_ID 'proposal ID'
   $proposalMetadata=Get-Internal ('/internal/action-proposals/'+[uri]::EscapeDataString($ProposalId))
   ```

4. Human gate: the eligible owner/admin confirms the ticket, proposal version, target fingerprint,
   and full-text review scope, then manually opens the existing OAuth review and approves that exact
   Feishu card. Never use proposal GET/reconcile to forge it. Expected durable proof is current
   attestation/approval; inspect IDs/versions/role/hash only. `action_target_fingerprint` is the
   managed-update schema field added by the Task 5 migration:

   ```sql
BEGIN READ ONLY;
SELECT id, proposal_id, proposal_version, subject_revision, subject_version, content_hash, action_target_fingerprint, reviewed_at
FROM action_review_attestations WHERE proposal_id = :'proposal_id' ORDER BY reviewed_at, id;
SELECT a.id, a.proposal_id, a.requirement_id, a.subject_revision, a.subject_version,
       a.authorization_summary, a.created_at, r.requirement_kind, r.role_ref_type, r.state,
       r.satisfied_source_type, r.satisfied_source_id
FROM action_approvals AS a
JOIN action_approval_requirements AS r ON r.id = a.requirement_id AND r.proposal_id = a.proposal_id
WHERE a.proposal_id = :'proposal_id' ORDER BY a.created_at, a.id;
COMMIT;
```

   Stop on missing/stale/extra approval or role mismatch; enter rollback without any manual retry.

5. Before mutation, prove barrier/non-retrievability and exactly one execution request fingerprint.
   After the approved system mutation, run this read-only, parameterized projection. Expected durable
   readback: strictly advanced revision, expected after hash, exactly one request, unchanged neighbor
   count/type/hash fingerprint. Private Feishu UI comparison supplies neighbor evidence; no raw block
   token/ID is exported:

   ```sql
BEGIN READ ONLY;
SELECT id, proposal_id, approval_id, executor_id, managed_page_id, managed_page_version,
       update_target_id, attempt_number, state, version, request_fingerprint,
       expected_remote_revision_id, before_body_content_hash, after_body_content_hash,
       response_revision_id, reconciliation_reason_code
FROM knowledge_publication_update_executions WHERE proposal_id = :'proposal_id';
SELECT id, proposal_id, approval_id, execution_id, managed_page_id, document_source_id,
       before_remote_revision_id, after_remote_revision_id, before_body_content_hash,
       after_body_content_hash, operation_fingerprint, completed_at
FROM knowledge_publication_updates WHERE proposal_id = :'proposal_id';
COMMIT;
```

   Stop on a second request, lower/equal revision, wrong page/block, neighbor change, or human edit;
   enter rollback. `POST /internal/managed-knowledge-updates/$([uri]::EscapeDataString($ExecutionId))/reconcile`
   is only for an existing unresolved execution with exact execution/page versions and an operator
   operation key; it is not an approval or blind retry. If it is ever authorized, first set
   `$ExecutionId=Require-Id $env:IRIS_PILOT_EXECUTION_ID 'execution ID'`; normal pilot acceptance
   never invokes this recovery route.

6. Keep the barrier until normal sync observes the exact source/snapshot/revision/hash tuple and the
   page becomes `active`; only then perform permitted retrieval and record IDs/hash/version, not text.
   Stop for early retrieval, mismatched reactivation, or nonzero managed reconciliation count.

7. Recheck both controls against their baselines, then run status and durable-state projections.
   Expected: controls unchanged and every pending/processing/delayed/DLQ/unresolved count zero.

## Rollback and closeout

Human first restores private deployment flag false/empty allowlist and deploys the same approved
image through normal change control; this blocks **new claims** but must not stop recovery/admin.
Then, after `Confirm-LiveWrite` before each mutation, disable global, pilot group, and both
capabilities with the same actual routes/payloads:

```powershell
$r=Invoke-InternalWrite Post '/internal/runtime-control/global' @{enabled=$false} 'disable global runtime' { param($s) Assert-RuntimeCoherent $s 'Post-confirm global disable precondition' }; Durable $r $false 'Global disable'
$afterGlobal=Get-Internal '/internal/runtime-control/status'; Assert-GlobalDisabled $afterGlobal 'Post-global disable readback'
$r=Invoke-InternalWrite Post ('/internal/runtime-control/groups/'+[uri]::EscapeDataString($PilotGroupId)) @{enabled=$false} 'disable pilot group' { param($s) Assert-GlobalDisabled $s 'Post-confirm group disable precondition'; Assert-PilotGroupShape $s 'Post-confirm group disable precondition' }; Durable $r $false 'Group disable'
$afterGroup=Get-Internal '/internal/runtime-control/status'; Assert-PilotGroupDisabled $afterGroup 'Post-group disable readback'
$r=Invoke-InternalWrite Patch '/internal/runtime-control/capabilities' @{writeKnowledgeBase=$false;updateManagedKnowledge=$false} 'disable managed-update capabilities' { param($s) Assert-PilotGroupDisabled $s 'Post-confirm capability disable precondition'; Assert-CapabilityShape $s 'Post-confirm capability disable precondition' }; Durable $r $false 'Capability disable'
$final=Get-Internal '/internal/runtime-control/status'; Assert-RuntimeState $final $false $true $false $false 'Final disable readback'
$recovery=Get-Internal '/internal/action-approvals/status'; if ((Prop $recovery ok 'action-approvals status') -ne $true) { throw 'Action-approvals recovery status is unreadable' }; $recoveryManaged=Prop $recovery managedKnowledgeUpdates 'action-approvals status'; if ((Prop $recoveryManaged running 'action-approvals status.managedKnowledgeUpdates') -ne $true) { throw 'Managed recovery/admin runtime is not running' }
Assert-ContentFreeDrain $true
```

Expected: this idempotent rollback accepts any coherent partial-enable stage, and each post-human-gate
read verifies the next disable action's actual state before dispatch. Durable response/readbacks prove
global false, then group disabled, then both capabilities false. It then proves the action-approval
managed recovery/admin loop remains running, requires the managed-update deployment's disabled status
shape, and executes the final content-free queue/DLQ plus durable-SQL drain to zero. Stop/escalate for persistence current/desired mismatch, unavailable
recovery/admin, a nonzero queue/DLQ/unresolved count, or a barred page. Never delete
history/queues/facts or blind-retry remote work. Mark **passed**
only when every evidence field is non-pending; otherwise it remains **not yet run / controlled Feishu
acceptance pending**.
