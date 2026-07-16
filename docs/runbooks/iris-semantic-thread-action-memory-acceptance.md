# Iris Semantic Thread And Action Memory Acceptance

This runbook is an unexecuted real-Feishu gray gate for one approved group. It does not authorize a
production rollout. Run it only after the controller's two-stage review. Keep every other group
outside both extraction allowlists, and do not send automated setup or acceptance messages.

## Preconditions

Record an approved group ID as `$pilotGroupId` and a different non-allowlisted group as
`$controlGroupId`. Use unique acceptance text that is not present in either group's existing state.
Before changing the allowlists, keep global Iris and both groups durably disabled. Explicitly persist
`proactiveSpeech=false` and verify the returned mutation says `durable: true`:

```powershell
$irisHeaders=@{Authorization="Bearer $env:IRIS_INTERNAL_API_TOKEN"}
$irisOperatorHeaders=@{
  Authorization="Bearer $env:IRIS_INTERNAL_API_TOKEN"
  "X-Iris-Operator"="iris-semantic-gray"
}

Invoke-RestMethod -Method Post -Headers $irisOperatorHeaders `
  -Uri http://localhost:3000/internal/runtime-control/global `
  -ContentType "application/json" -Body '{"enabled":false}'
Invoke-RestMethod -Method Post -Headers $irisOperatorHeaders `
  -Uri "http://localhost:3000/internal/runtime-control/groups/$pilotGroupId" `
  -ContentType "application/json" -Body '{"enabled":false}'
Invoke-RestMethod -Method Post -Headers $irisOperatorHeaders `
  -Uri "http://localhost:3000/internal/runtime-control/groups/$controlGroupId" `
  -ContentType "application/json" -Body '{"enabled":false}'
Invoke-RestMethod -Method Patch -Headers $irisOperatorHeaders `
  -Uri http://localhost:3000/internal/runtime-control/capabilities `
  -ContentType "application/json" -Body '{"proactiveSpeech":false}'
```

Set exactly one group in the private pilot environment, retain the exact thresholds, and enable the
existing extraction runtime:

```text
IRIS_MEMORY_EXTRACTION_ENABLED=true
IRIS_THREAD_EXTRACTION_GROUP_IDS=<approved-group-id>
IRIS_ACTION_EXTRACTION_GROUP_IDS=<approved-group-id>
IRIS_THREAD_CANDIDATE_CONFIDENCE_FLOOR=0.65
IRIS_MEMORY_EXTRACTION_MIN_CONFIDENCE=0.85
```

Restart Core privately with Caddy stopped. Run migrations, `npm run readiness -- --env-file
.env.pilot`, and query `GET /internal/readiness`; require `ok: true` with no failed check. Query
`GET /internal/ingress-readiness` with the operator bearer and require `ok: true`, `status: "ready"`.
Query `GET /internal/status` and require every enabled runtime healthy. Confirm public `/internal/*`
AI Worker has no published port, and Caddy configuration routes only `/health` and `/feishu/events`
to Core. Then start Caddy, require public `/health` to return `200`, and require public
`/internal/status`, `/internal/readiness`, and `/internal/ingress-readiness` to return `404`.

Only after those checks, durably enable `$pilotGroupId` and then global Iris. Keep `$controlGroupId`
disabled:

```powershell
Invoke-RestMethod -Method Post -Headers $irisOperatorHeaders `
  -Uri "http://localhost:3000/internal/runtime-control/groups/$pilotGroupId" `
  -ContentType "application/json" -Body '{"enabled":true}'
Invoke-RestMethod -Method Post -Headers $irisOperatorHeaders `
  -Uri http://localhost:3000/internal/runtime-control/global `
  -ContentType "application/json" -Body '{"enabled":true}'
```

Require both responses to say `durable: true`. Re-read runtime-control status and require
`proactiveSpeech=false` before asking a human participant to send the acceptance conversation.

## Human Acceptance Conversation

Use a unique topic marker such as `IRIS-GRAY-<date>-ALPHA`. Human participants send these in the
approved group; the operator does not send them through an API.

1. Ordinary discussion, without mentioning Iris: introduce the marker, a concrete decision still
   under discussion, and one relevant fact.
2. Evidence promotion, still without mentioning Iris: add a second message that clearly continues
   the same topic. Poll the approved group's thread endpoint until the same evidence-bound thread is
   `open`, not `candidate`.
3. Explicit commitment: one participant states that they personally commit to one concrete action;
   a due date is optional. Poll until exactly one matching `open` action has the correct Feishu owner
   and evidence message ID.
4. Mention question: mention Iris and ask for the current topic decision and commitment. Require an
   accurate answer grounded only in the approved group's open thread/action state.
5. Completion: the owner explicitly states the action is complete and the discussion is resolved.
   Poll until the action is `completed` and the thread is `resolved`.
6. Reopening: without mentioning Iris, add explicit new evidence that reopens the same topic. Poll
   until the same canonical thread is `open` at a higher version; no duplicate thread/action may be
   created.

Inspect state only through loopback operator routes:

```powershell
$pilotThreads = Invoke-RestMethod -Headers $irisHeaders `
  -Uri "http://localhost:3000/internal/conversation-state/groups/$pilotGroupId/threads?limit=20"
$pilotActions = Invoke-RestMethod -Headers $irisHeaders `
  -Uri "http://localhost:3000/internal/conversation-state/groups/$pilotGroupId/actions?limit=20"
$controlThreads = Invoke-RestMethod -Headers $irisHeaders `
  -Uri "http://localhost:3000/internal/conversation-state/groups/$controlGroupId/threads?limit=20"
$controlActions = Invoke-RestMethod -Headers $irisHeaders `
  -Uri "http://localhost:3000/internal/conversation-state/groups/$controlGroupId/actions?limit=20"
```

Require append-only events and exact evidence IDs for every transition. Require that none of the
approved-group thread/action IDs or evidence IDs appear in `$controlThreads` or `$controlActions`.
Do not expect the control group to be empty if it already has unrelated historical state.

## No-Send And Drain Gates

From the first ordinary message through at least two extraction intervals after reopening, require
no Iris message except the single direct answer to the explicit @Iris question. Any reminder,
follow-up, status update, or other unsolicited message fails the gate.

Read the private status endpoints and require every listed count to be numeric zero:

```powershell
$status = Invoke-RestMethod -Headers $irisHeaders `
  -Uri http://localhost:3000/internal/status
$events = Invoke-RestMethod -Headers $irisHeaders `
  -Uri http://localhost:3000/internal/events/status
$extraction = Invoke-RestMethod -Headers $irisHeaders `
  -Uri http://localhost:3000/internal/memory-extraction/status
$state = Invoke-RestMethod -Headers $irisHeaders `
  -Uri http://localhost:3000/internal/conversation-state/status

$zeroGates = [ordered]@{
  eventPending = $events.pendingEventCount
  eventDlq = $events.deadLetterEventCount
  documentPending = $status.components.documentSync.pendingJobCount
  documentDlq = $status.components.documentSync.deadLetterJobCount
  reindexPending = $status.components.reindex.pendingJobCount
  reindexDlq = $status.components.reindex.deadLetterJobCount
  pendingJobCount = $extraction.pendingJobCount
  processingJobCount = $extraction.processingJobCount
  delayedJobCount = $extraction.delayedJobCount
  deadLetterJobCount = $extraction.deadLetterJobCount
  pendingProjectionRepairCount = $extraction.pendingProjectionRepairCount
  failedProjectionRepairCount = $extraction.failedProjectionRepairCount
  projectionProcessing = $state.projectionRepairs.processing
}
if ($zeroGates.Values | Where-Object { $_ -ne 0 }) {
  throw "Conversation-state drain gate failed: $($zeroGates | ConvertTo-Json -Compress)"
}
```

Also require Redis raw-event processing to be zero:

```powershell
docker compose --env-file .env.pilot --file deploy/pilot/docker-compose.yml `
  exec -T redis redis-cli LLEN iris:events:raw:processing
```

The command must print `0`. Recheck `/internal/readiness`, `/internal/ingress-readiness`, and
`/internal/status` after drain. Any queue, DLQ, failed repair, permission violation, duplicate,
cross-group state, unsolicited message, or unhealthy readiness result fails acceptance.

## Cleanup And Evidence

Record the deployed commit, group IDs, timestamps, state entity/event IDs, status JSON with counts
only, readiness results, and the observed Feishu messages. Do not put message content or secrets in
operator logs. After evidence capture, durably disable global Iris first and then the pilot group:

```powershell
Invoke-RestMethod -Method Post -Headers $irisOperatorHeaders `
  -Uri http://localhost:3000/internal/runtime-control/global `
  -ContentType "application/json" -Body '{"enabled":false}'
Invoke-RestMethod -Method Post -Headers $irisOperatorHeaders `
  -Uri "http://localhost:3000/internal/runtime-control/groups/$pilotGroupId" `
  -ContentType "application/json" -Body '{"enabled":false}'
```

Require both responses to say `durable: true`, stop Caddy, restore both thread/action allowlists to
blank, restart Core privately, prove the disabled state, and only then restore Caddy. Real gray
acceptance remains pending until the controller records every gate as pass.
