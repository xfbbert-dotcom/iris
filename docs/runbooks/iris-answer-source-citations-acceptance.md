# Iris Answer-Source Citation Acceptance

This runbook is the only rollout path for answer-source citations. It is bounded to the existing
pilot group, one new non-secret Wiki marker, one authorized answer, and one permission-revocation
check. It does not approve another group, daily rollout, or a second model probe.

Any failure restores `globalEnabled=false` and `desiredGlobalEnabled=false` and stops Caddy until
the failing gate is understood. If durable disablement cannot be proved, stop Core as well. Never
resume from a desired state automatically.

## Evidence And Inputs

Record evidence in the private deployment log, then copy only content-free identifiers and results
to the PR document. Never record tokens, application secrets, user open IDs, prompts, answer bodies,
document bodies, or raw provider responses.

```bash
export CANDIDATE_SHA=replace-with-full-reviewed-commit-sha
export DRAFT_PR=replace-with-draft-pr-number
export PILOT_GROUP_ID=replace-with-existing-approved-pilot-group-id
export PILOT_MESSAGE_ID=replace-after-the-real-message
export PILOT_MARKER=IRIS_CITATION_$(date -u +%Y%m%d)_replace-with-six-random-digits
export PILOT_SOURCE_TITLE=replace-with-new-wiki-page-title
export PILOT_SOURCE_URL=replace-with-canonical-feishu-wiki-url
```

Use the existing `.env.pilot` and operator configuration. Do not source or print that file. From
the repository root on the VPS, define the existing Compose invocation without exposing values:

```bash
compose=(docker compose --env-file .env.pilot --file deploy/pilot/docker-compose.yml)
```

## 1. Candidate And CI Gate

The candidate SHA, checked-out SHA, `IRIS_IMAGE_TAG`, Core image tag, and AI Worker image tag must be
the same full SHA. The draft PR must be stacked on `codex/iris-chat-knowledge-drafts`, and its Core
and AI Worker checks must both be successful for that exact head SHA.

```bash
test "$(git rev-parse HEAD)" = "$CANDIDATE_SHA"
test "$(git status --porcelain)" = ""
mapfile -t images < <("${compose[@]}" config --images)
printf '%s\n' "${images[@]}" | grep -Fx "iris-core:$CANDIDATE_SHA" >/dev/null
printf '%s\n' "${images[@]}" | grep -Fx "iris-ai-worker:$CANDIDATE_SHA" >/dev/null
```

On the operator machine, run `gh pr checks --repo xfbbert-dotcom/iris --watch` and record the Core
and AI Worker run URLs. Stop if the PR head SHA is not `CANDIDATE_SHA` or either check is not
successful.

## 2. Fail-Closed Preflight

Capture the previously approved pilot runtime state in the private deployment log before changing
anything. Then durably disable Iris, stop Caddy, and verify all private gates. Use container-local
Node for authenticated calls so the bearer token never enters shell output.

```bash
"${compose[@]}" stop caddy
"${compose[@]}" exec --no-TTY core node --input-type=module --eval '
  const headers = {
    authorization: `Bearer ${process.env.IRIS_INTERNAL_API_TOKEN}`,
    "content-type": "application/json",
    "x-iris-operator": "answer-citation-acceptance",
  };
  const disabled = await fetch("http://127.0.0.1:3000/internal/runtime-control/global", {
    method: "POST", headers, body: JSON.stringify({ enabled: false }),
  });
  if (!disabled.ok) process.exit(1);
  const response = await fetch("http://127.0.0.1:3000/internal/status", { headers });
  const body = await response.json();
  const runtime = body?.components?.runtimeControl;
  const event = body?.components?.eventWorker;
  const document = body?.components?.documentSync;
  const reindex = body?.components?.reindex;
  const counts = [
    event?.pendingEventCount, event?.deadLetterEventCount,
    document?.pendingJobCount, document?.deadLetterJobCount,
    reindex?.pendingJobCount, reindex?.deadLetterJobCount,
  ];
  if (!response.ok || runtime?.globalEnabled !== false
    || runtime?.desiredGlobalEnabled !== false
    || event?.running !== true || document?.running !== true || reindex?.running !== true
    || counts.some((count) => count !== 0)) process.exit(1);
  process.stdout.write(JSON.stringify({
    globalEnabled: runtime.globalEnabled,
    desiredGlobalEnabled: runtime.desiredGlobalEnabled,
    event: [event.pendingEventCount, event.deadLetterEventCount],
    document: [document.pendingJobCount, document.deadLetterJobCount],
    reindex: [reindex.pendingJobCount, reindex.deadLetterJobCount],
  }) + "\n");
'
test -z "$("${compose[@]}" ps --status running --services | grep -Fx caddy || true)"
```

Do not continue unless Core, AI Worker, Postgres, Redis, and every enabled worker are healthy and
every pending and DLQ count is zero.

## 3. Backup, Migration, And Images

Create and verify the encrypted PostgreSQL/Redis backup before migration `0045`. Record the backup
identifier only after the script returns success and the published file exists.

```bash
backup_path="$(/usr/local/sbin/iris-backup | tail -n 1)"
test -n "$backup_path" && test -f "$backup_path"
test -z "$("${compose[@]}" ps --status running --services | grep -Fx caddy || true)"
```

Build both images from the same detached candidate checkout, apply migrations, and start only the
private services. Caddy remains stopped and Iris remains globally and durably disabled.

```bash
"${compose[@]}" config --quiet
"${compose[@]}" build core ai-worker
"${compose[@]}" up --detach --wait --wait-timeout 120 postgres redis migrate ai-worker core
"${compose[@]}" exec --no-TTY postgres sh -c \
  'psql --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" --tuples-only --no-align \
    --command "select count(*) from schema_migrations where name = '\''0045_answer_source_citations.sql'\''"' \
  | grep -Fx 1 >/dev/null
test "$(docker inspect --format '{{.Config.Image}}' "$("${compose[@]}" ps -q core)")" \
  = "iris-core:$CANDIDATE_SHA"
test "$(docker inspect --format '{{.Config.Image}}' "$("${compose[@]}" ps -q ai-worker)")" \
  = "iris-ai-worker:$CANDIDATE_SHA"
```

Repeat the complete fail-closed preflight after startup. A backup, migration, or healthy container
does not authorize ingress or runtime activation.

## 4. Receipt And Public-Boundary Gates

Before deployment acceptance, the focused local suite must prove exact replay, clearing of
`prepared_reply_text` after terminal transitions, and content-free private inspection. The API must
map fields explicitly; it must not spread the delivery row or expose `preparedReplyText`,
`fragmentText`, `promptContext`, app secrets, or access tokens.

Start Caddy only long enough to verify the disabled public boundary from a machine outside the VPS:

```bash
"${compose[@]}" up --detach --wait --wait-timeout 120 caddy
curl --fail --silent --show-error "https://${IRIS_PUBLIC_HOSTNAME}/health" >/dev/null
test "$(curl --silent --output /dev/null --write-out '%{http_code}' \
  "https://${IRIS_PUBLIC_HOSTNAME}/internal/answer-replies/feishu/probe")" = 404
"${compose[@]}" stop caddy
```

Re-read runtime control and require both global values to remain false. Any non-`200` public health,
non-`404` private route, or runtime change fails the gate.

## 5. One Authorized Pilot Answer

Create one new Feishu Wiki page shared with the Iris app. Its body contains only the unique marker
and bounded non-sensitive test text. Record its exact title and canonical Feishu URL. Confirm it is
synced and indexed and the live permission guard is `allowed` before using the answer provider.

Disable every known non-pilot group. Restore only the previously approved pilot capabilities,
enable only `PILOT_GROUP_ID`, durably enable global runtime, verify the resulting inventory, arm the
existing automatic fail-closed timer, and start Caddy last. Do not use repeated Gemini probes.

The human tester sends one real marker question in the existing pilot group. Record the incoming
Feishu message ID and visible reply. The reply must contain all of:

- the unique marker as the answer;
- `Iris 参考资料：`;
- the exact Wiki title;
- the canonical Feishu URL.

Inspect the private receipt by incoming message ID through the operator tunnel or container-local
request:

```bash
"${compose[@]}" exec --no-TTY core node --input-type=module --eval '
  const id = process.env.PILOT_MESSAGE_ID;
  if (!id) process.exit(1);
  const response = await fetch(
    `http://127.0.0.1:3000/internal/answer-replies/feishu/${encodeURIComponent(id)}`,
    { headers: { authorization: `Bearer ${process.env.IRIS_INTERNAL_API_TOKEN}` } },
  );
  const body = await response.json();
  if (!response.ok || body?.ok !== true || !Array.isArray(body.sources)) process.exit(1);
  const serialized = JSON.stringify(body);
  for (const forbidden of ["preparedReplyText", "fragmentText", "promptContext"]) {
    if (serialized.includes(forbidden)) process.exit(1);
  }
  process.stdout.write(serialized + "\n");
'
```

The receipt must contain the exact source ID, snapshot ID, fragment ID, chunk index, content hash,
title, and canonical URL used for the answer, and must contain no answer or fragment body.

## 6. Permission Revocation

Revoke the Iris app's access to only the new Wiki page. Re-send the same Feishu event by the normal
platform retry path or repeat the same bounded question once if Feishu cannot replay it. The unique
marker and original answer must not be emitted. Only the safe permission-changed notice may be sent.
The receipt must show a permission-blocked terminal path and no answer-send attempt.

If a human must change Feishu sharing or send the message, request exactly that one action and stop.
Keep Iris globally disabled and Caddy stopped while waiting; do not invent message or sharing
evidence.

## 7. Final Zero State And Restoration

Stop Caddy and durably disable Iris before final inspection. Require event, document-sync, and
reindex pending/DLQ counts to be zero. The event-worker answer-reply fields must be zero and are
recorded in evidence as `unresolvedCount=0`, `pendingSafeNoticeCount=0`, and
`reconciliationRequiredCount=0`:

```text
answerReplyUnresolvedCount=0
answerReplyPendingSafeNoticeCount=0
answerReplyReconciliationRequiredCount=0
```

Only after every gate above passes may the operator restore the previously approved pilot runtime
state and start Caddy according to the Controlled Daily Pilot Profile. If any gate remains open,
leave `globalEnabled=false`, `desiredGlobalEnabled=false`, Caddy stopped, and the draft PR unmerged.

## Evidence Checklist

- candidate SHA and matching Core/AI Worker tags;
- Core and AI Worker CI run URLs for that SHA;
- backup identifier and successful `0045` migration result;
- disabled preflight and public `200`/`404` boundary result;
- incoming and reply Feishu message IDs;
- source ID, snapshot ID, fragment ID, chunk index, and content hash;
- visible citation title and canonical URL result, without answer body;
- permission-revocation and safe-notice result;
- final event/document/reindex and answer-reply counts;
- final fail-closed state or explicitly restored approved pilot state.
