# Iris Wiki Space Sync Runbook

## Scope And Preconditions

Wiki-space discovery is deployment-default-off. Keep
`IRIS_WIKI_SPACE_SYNC_ENABLED=false` until the operator has a bounded Feishu wiki root, a reviewed
pilot, and clean raw-event, document-sync, and reindex queues. It requires
`IRIS_DOCUMENT_SYNC_WORKER_ENABLED=true`; Core rejects the configuration otherwise.

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

Register one approved root URL. Registration is idempotent for its canonical root and returns an
authorization in `pending` state; it does not expose document bodies in the response.

```powershell
$wikiRootUrl = "https://example.feishu.cn/wiki/wiki_root_token"
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

First disable the affected root when the failure could involve access. Fix the underlying cause
(for example, an invalid root, missing Feishu scope, revoked access, or transient Feishu outage),
then replay only the reviewed item in the affected queue. For a wiki scan `dead_letter`, use the
explicit rescan endpoint after repair instead of repeatedly toggling the root.

```powershell
$deadLetterId = "replace-with-reviewed-document-sync-dlq-id"
Invoke-RestMethod -Method Post -Headers $irisHeaders `
  -Uri "$irisBaseUrl/internal/document-sync/dead-letters/$deadLetterId/replay"
```

Use the analogous `/internal/events/dead-letters/<id>/replay` or
`/internal/reindex/dead-letters/<id>/replay` endpoint only for the matching queue. Do not replay an
unchanged permission denial. Recheck `/internal/status`, all three DLQ lists, and the wiki-space
list after recovery; every pending and dead-letter count must return to zero.

## Permission Revocation Second Check

For a previously synced pilot document, remove the app's effective Feishu access through the real
space, node, folder, or membership control. Disable the affected wiki root immediately. Record the
root ID, document URL, and revocation time without recording its body.

Perform two independent post-revocation checks:

1. Request a rescan and verify it produces a permission-denied classification or a safe
   `retry_wait`/`dead_letter` outcome without registering new readable content. Inspect the
   wiki-space list and all three queue/DLQ surfaces after the attempt.
2. After the queue gate settles, issue one ordinary pilot-group question whose answer depends only
   on the revoked document's unique marker. The deployed source-policy live permission guard must
   deny the fragment: the reply must not contain the marker or cite the revoked source. Record the
   content-free permission decision/audit evidence. Do not repeat the answer request to probe a
   hosted model.

Any marker exposure, citation, uncertain permission result, or non-zero DLQ is a failed gate: keep
the root disabled and enter rollback.

## Rollback

Set `IRIS_WIKI_SPACE_SYNC_ENABLED=false` in the operator-controlled `.env.pilot`, restart only
through the reviewed pilot deployment procedure with Caddy stopped, and verify that
`$status.components.documentSync.wikiSpaces` is absent after Core is healthy. Do not delete the
authorization records or Redis/Postgres data as part of this rollback.

Keep affected roots disabled, inspect event/document-sync/reindex pending and DLQ counts until they
are zero, and retain the root IDs, failure classification, queue snapshots, and timestamps for the
incident record. Re-enable deployment wiring only after a new operator review and the complete
register-to-permission-revocation gate passes.
