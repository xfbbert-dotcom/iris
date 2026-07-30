# Iris Wiki Space Sync Runbook

## Scope And Preconditions

Wiki-space discovery is deployment-default-off. Keep
`IRIS_WIKI_SPACE_SYNC_ENABLED=false` until the operator has an authorized, bounded Feishu knowledge
space, a reviewed pilot, and clean raw-event, document-sync, and reindex queues. It requires
`IRIS_DOCUMENT_SYNC_WORKER_ENABLED=true`; Core rejects the configuration otherwise.

The registration URL may point to any page in the intended knowledge space. Iris uses the page only
to resolve the space ID, then enumerates all top-level trees. Before registration, add the Iris
application as a member of the knowledge space itself; sharing only one page or subtree is
insufficient. A scan that can read the anchor but cannot enumerate the space fails closed as
`forbidden`.

Keep the approved first-release scan defaults aligned across Core and pilot configuration:
`IRIS_WIKI_SPACE_SYNC_REFRESH_INTERVAL_MS=21600000` (6 hours),
`IRIS_WIKI_SPACE_SYNC_LEASE_MS=600000` (10 minutes), and
`IRIS_WIKI_SPACE_SYNC_MAX_ATTEMPTS=5`. Do not shorten the lease for the 500-node traversal bound
without a reviewed design amendment.

Before any authenticated request, load the internal API token into the current process from the
operator's secret store. Do not put a token in a shell command, script, transcript, or shell-history
example.

```powershell
if ([string]::IsNullOrWhiteSpace($env:IRIS_INTERNAL_API_TOKEN)) {
  throw "IRIS_INTERNAL_API_TOKEN must be supplied by the operator environment"
}
$irisBaseUrl = "http://localhost:3000"
$irisHeaders = @{ authorization = "Bearer $env:IRIS_INTERNAL_API_TOKEN" }
```

All endpoints in this runbook are private `localhost` endpoints. Caddy must not proxy `/internal/*`.

## Status And Queue Gate

Inspect the shared worker state before registration, after every scan, and before re-enabling a
space:

```powershell
$status = Invoke-RestMethod -Headers $irisHeaders -Uri "$irisBaseUrl/internal/status"
$status.components.eventWorker
$status.components.documentSync
$status.components.reindex
$status.components.documentSync.wikiSpaces
```

Require `ok=true`, `enabled=true`, and `running=true` for event, document-sync, and reindex workers.
Require every `pendingJobCount` and `deadLetterJobCount` to be `0` before enabling a space or
declaring the operation complete. The wiki scan loop is present only when enabled; its
`running=true`, configured `intervalMs`, and `statusCounts` provide the additional scan gate.

The three shared queue families are:

- `eventWorker`: Feishu raw events; a backlog can delay registration-related callbacks.
- `documentSync`: discovered wiki documents awaiting fetch and snapshot persistence.
- `reindex`: synced snapshots awaiting embedding/index work.

Do not treat a zero wiki `statusCounts.pending` count as proof that the document-sync or reindex
queues are empty. All three queue families must be clean.

Wiki authorization state meanings:

- `pending`: eligible for the next scan.
- `scanning`: claimed with a lease; wait for it to finish rather than issuing concurrent operations.
- `synced`: the last traversal completed and the next scheduled refresh is recorded.
- `retry_wait`: a retriable scan failure is waiting for its scheduled retry.
- `dead_letter`: scan attempts are exhausted or the failure is terminal; it needs diagnosis and an
  explicit rescan after repair.
- `disabled`: the root is retained but is not eligible for scanning.

## Register, Inspect, Rescan, And Enablement

Register one approved page URL from the space. Registration is idempotent for its canonical anchor and returns an
authorization in `pending` state; it does not expose document bodies in the response.

```powershell
$wikiRootUrl = "https://example.feishu.cn/wiki/any_page_token_in_the_space"
Invoke-RestMethod -Method Post -Headers $irisHeaders `
  -Uri "$irisBaseUrl/internal/document-sync/wiki-spaces" `
  -ContentType "application/json" `
  -Body (@{ rootSourceUri = $wikiRootUrl } | ConvertTo-Json -Compress)
```

List authorizations and record the returned `id`, `scanState`, counts, and timestamps:

```powershell
Invoke-RestMethod -Headers $irisHeaders `
  -Uri "$irisBaseUrl/internal/document-sync/wiki-spaces?limit=20"
```

Request a bounded explicit rescan only after the previous scan has settled:

```powershell
$wikiSpaceId = "replace-with-returned-wiki-space-id"
Invoke-RestMethod -Method Post -Headers $irisHeaders `
  -Uri "$irisBaseUrl/internal/document-sync/wiki-spaces/$wikiSpaceId/rescan" `
  -ContentType "application/json" `
  -Body "{}"
```

Disable immediately when access, scope, or queue health is uncertain. Disabling clears a lease and
sets `scanState=disabled`; it does not delete already persisted document data.

```powershell
Invoke-RestMethod -Method Patch -Headers $irisHeaders `
  -Uri "$irisBaseUrl/internal/document-sync/wiki-spaces/$wikiSpaceId" `
  -ContentType "application/json" `
  -Body '{"enabled":false}'
```

After the queue and permission gates pass, enable the retained root. Enabling returns it to
`pending`; re-list it and wait for `synced` before considering the scan complete.

```powershell
Invoke-RestMethod -Method Patch -Headers $irisHeaders `
  -Uri "$irisBaseUrl/internal/document-sync/wiki-spaces/$wikiSpaceId" `
  -ContentType "application/json" `
  -Body '{"enabled":true}'
```

## Dead-Letter Diagnosis And Recovery

Inspect all three DLQs; a scan `dead_letter` state is separate from the document-sync and reindex
queue DLQs, so inspect both the wiki authorization and these endpoints.

```powershell
Invoke-RestMethod -Headers $irisHeaders -Uri "$irisBaseUrl/internal/events/dead-letters?limit=20"
Invoke-RestMethod -Headers $irisHeaders -Uri "$irisBaseUrl/internal/document-sync/dead-letters?limit=20"
Invoke-RestMethod -Headers $irisHeaders -Uri "$irisBaseUrl/internal/reindex/dead-letters?limit=20"
```

First disable the affected root when the failure could involve access. Keep it disabled while
fixing the underlying cause (for example, an invalid root, missing Feishu scope, revoked access, or
transient Feishu outage), then replay only the reviewed item in the affected queue.

```powershell
$deadLetterId = "replace-with-reviewed-document-sync-dlq-id"
Invoke-RestMethod -Method Post -Headers $irisHeaders `
  -Uri "$irisBaseUrl/internal/document-sync/dead-letters/$deadLetterId/replay"
```

Use the analogous `/internal/events/dead-letters/<id>/replay` or
`/internal/reindex/dead-letters/<id>/replay` endpoint only for the matching queue. Do not replay an
unchanged permission denial.

For a wiki scan `dead_letter`, a disabled root cannot accept a rescan request. After repair, use
this bounded sequence instead of repeatedly toggling it. Enable the retained root only for the
probe:

```powershell
Invoke-RestMethod -Method Patch -Headers $irisHeaders `
  -Uri "$irisBaseUrl/internal/document-sync/wiki-spaces/$wikiSpaceId" `
  -ContentType "application/json" `
  -Body '{"enabled":true}'
```

Request exactly one rescan:

```powershell
Invoke-RestMethod -Method Post -Headers $irisHeaders `
  -Uri "$irisBaseUrl/internal/document-sync/wiki-spaces/$wikiSpaceId/rescan" `
  -ContentType "application/json" `
  -Body "{}"
```

Observe the resulting authorization and all event/document/reindex queue/DLQ gates. Recheck
`/internal/status`, all three DLQ lists, and the wiki-space list; every pending and dead-letter
count must return to zero. Disable the root again immediately after the result settles:

```powershell
Invoke-RestMethod -Method Patch -Headers $irisHeaders `
  -Uri "$irisBaseUrl/internal/document-sync/wiki-spaces/$wikiSpaceId" `
  -ContentType "application/json" `
  -Body '{"enabled":false}'
```

## Answer And Citation Evidence

Feishu may render a native `相关知识` recommendation below a chat reply. That recommendation belongs
to Feishu's own client-side knowledge feature; it is not an Iris citation and does not prove that
Iris retrieved, authorized, or supplied the recommended page to the model.

The current internal release stores aggregate retrieval counts but does not yet persist the exact
source IDs supplied for each answer, and it does not render Iris-owned source citations. Therefore,
do not claim source-level trace or citation acceptance for this release.

For a bounded end-to-end retrieval smoke test, require all of these independent signals:

1. The relevant source has a successful snapshot and at least one indexed document fragment.
2. The live permission guard allows that exact source for the requesting chat at answer time.
3. A unique test marker exists only in that authorized document, not in group messages, memories,
   another indexed source, or the question itself.
4. One ordinary Iris answer returns the exact marker while aggregate retrieval telemetry reports
   at least one allowed fragment.

Do not use Feishu-native `相关知识`, search suggestions, page previews, or other client decorations
as acceptance evidence. Record a passing marker test as bounded retrieval evidence, not as proof of
a durable source-level trace or citation feature. Common-knowledge answers are not retrieval proof.

## Local Embedding Acceptance

Use this section only after the private model procedure has selected
`openai-compatible:qwen3-embedding:0.6b:1024` and the bounded reindex planning loop in the
[internal rollout runbook](../operations/internal-rollout-runbook.md#local-embedding-profile-migration)
has returned zero work. Retain prior-profile fragments and old Gemini-profile DLQ evidence; neither
is discarded merely because the Qwen profile has become active.

With Caddy stopped, choose a Life Engine page that is authorized for the pilot group and place a
fresh unique marker only in that page. Confirm the source has a successful latest snapshot and a
fragment under the Qwen profile. Submit one authenticated internal answer-draft request for the
pilot chat with no copied marker in the question or live-chat input. The deployed source-policy
live Feishu permission guard must allow the source, and the one result must contain the marker.
Record only the source ID, snapshot ID, profile ID, permission decision, request time, and marker
match; do not record the document body or prompt. Do not repeat a failed answer request to probe a
provider.

Feishu-native related-knowledge UI is not Iris evidence. A Feishu `相关知识` decoration, preview, or
search recommendation cannot replace the internal marker result or the live permission decision.
Use the private authenticated request and compensating durable global disable in the linked rollout
runbook; it keeps Caddy stopped while the source-policy guard evaluates the live Feishu permission.
Before ingress, recheck event, document-sync, and reindex status plus their DLQ lists; all pending
and dead-letter counts must be zero. Any missing fragment, denied/uncertain permission, marker
miss, or nonzero queue/DLQ keeps Caddy stopped and enters the local-embedding rollback procedure.

## Permission Revocation Second Check

For a previously synced pilot document, remove the app's effective Feishu access through the real
space, node, folder, or membership control. Disable the affected wiki authorization immediately.
Record the authorization ID, document URL, and revocation time without recording its body.

Perform two independent post-revocation checks:

1. A disabled root cannot accept a rescan request. Enable the retained root only for this bounded
   probe:

```powershell
Invoke-RestMethod -Method Patch -Headers $irisHeaders `
  -Uri "$irisBaseUrl/internal/document-sync/wiki-spaces/$wikiSpaceId" `
  -ContentType "application/json" `
  -Body '{"enabled":true}'
```

   Request exactly one rescan:

```powershell
Invoke-RestMethod -Method Post -Headers $irisHeaders `
  -Uri "$irisBaseUrl/internal/document-sync/wiki-spaces/$wikiSpaceId/rescan" `
  -ContentType "application/json" `
  -Body "{}"
```

   Observe the resulting authorization and all event/document/reindex queue/DLQ gates. Verify the
   scan produces a permission-denied classification or a safe `retry_wait`/`dead_letter` outcome
   without registering new readable content. Disable the root again immediately after the result
   settles:

```powershell
Invoke-RestMethod -Method Patch -Headers $irisHeaders `
  -Uri "$irisBaseUrl/internal/document-sync/wiki-spaces/$wikiSpaceId" `
  -ContentType "application/json" `
  -Body '{"enabled":false}'
```

2. After the root is disabled and the queue gate settles, issue one ordinary pilot-group question
   whose answer depends only
   on the revoked document's unique marker. The deployed source-policy live permission guard must
   deny the fragment: the reply must not contain the marker or cite the revoked source. Record the
   content-free permission decision/audit evidence. Do not repeat the answer request to probe a
   hosted model.

Any marker exposure, citation, uncertain permission result, or non-zero DLQ is a failed gate: keep
the root disabled and enter rollback.

## Rollback

Set `IRIS_WIKI_SPACE_SYNC_ENABLED=false` in the operator-controlled `.env.pilot`, restart only
through the reviewed pilot deployment procedure with Caddy stopped. After Core is healthy, fetch a
fresh authenticated status response; never reuse a pre-restart snapshot:

```powershell
$statusAfterRollback = Invoke-RestMethod -Headers $irisHeaders `
  -Uri "$irisBaseUrl/internal/status"
if ($null -ne $statusAfterRollback.components.documentSync.wikiSpaces) {
  throw "Wiki space sync is still present after rollback"
}
```

Do not delete the authorization records or Redis/Postgres data as part of this rollback.

Keep affected roots disabled, inspect event/document-sync/reindex pending and DLQ counts until they
are zero, and retain the root IDs, failure classification, queue snapshots, and timestamps for the
incident record. Re-enable deployment wiring only after a new operator review and the complete
register-to-permission-revocation gate passes.
