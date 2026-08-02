# Iris Permission-Safe Answer Citations

## Scope

This stacked change adds deterministic source citations and durable, content-minimized answer-reply
receipts to the existing Feishu mention-answer path. It is based on
`codex/iris-chat-knowledge-drafts` and does not merge or replace PR #22.

- Renders at most three cited sources in prompt rank order with the exact Iris reference footer.
- Captures immutable source snapshot, fragment, chunk, hash, title, and canonical URI metadata.
- Rechecks live source permission immediately before sending a prepared answer.
- Clears prepared answer text on every terminal transition while retaining only fingerprints and
  content-free source/event evidence.
- Replays a previously prepared or sent receipt without another model call or duplicate answer.
- Sends only the bounded safe notice when permission changes before answer delivery.
- Exposes a private receipt lookup with an explicit response mapping that omits answer and fragment
  body text.
- Reports unresolved, pending-safe-notice, and reconciliation-required receipt counts in event
  worker status.

## Fail-Closed Behavior

- Missing repository composition keeps mention replies unavailable.
- Receipt persistence, validation, permission verification, and ambiguous delivery outcomes fail
  closed; an unknown answer-send result is not silently retried as a fresh answer.
- Immutable source/event rows reject mutation and deletion.
- Public ingress and global runtime remain off through migration and private acceptance gates.
- Any failed rollout gate returns to durable global disablement with Caddy stopped.

## Local Verification

Fresh Task 8 verification used the local Docker Postgres at
`IRIS_TEST_DATABASE_URL=postgres://iris:iris@localhost:5432/iris`:

- Focused feature suite: 9 files passed, 350 tests passed, 0 skipped. The legacy document-fragment
  Postgres block was run by pointing its `DATABASE_URL` at the same isolated Docker database.
- Core full suite: 165 files passed, 3,056 tests passed, 16 conditional skips. All 70
  `postgres-answer-reply-repository` tests ran. The skips are 6 legacy tests gated by generic
  `DATABASE_URL`, 3 mixed Postgres/Redis tombstone tests gated by `IRIS_TEST_REDIS_URL`, and 7
  Redis-only runtime/queue tests; none are answer-reply database tests.
- AI Worker: 181 tests passed.
- Pilot operations, backup, and restore: 141 tests passed, 0 skipped.
- Core typecheck and production build: exit `0`.
- Root and pilot Compose rendering: exit `0`.
- Readiness: `ready`, 16 passed, 0 warnings, 0 failures.
- `git diff --check` and pilot configuration validation: exit `0`.

## Sensitive-Data Review

The feature-wide diff from `b25d8298fd396366c97449dfbe6f11f3dc42f8f9` contains only the planned
source-citation, answer-receipt, integration, test, plan, and evidence files. The Task 8 diff from
`b479d319721befcaa560e1988224edbfcf01f624` contains only the deferred status cleanup and rollout
documentation.

The required sensitive-field search finds only the transient `preparedReplyText` delivery field in
the repository, validator, and delivery service. Terminal receipt tests prove it is cleared. Source
traces and delivery events contain no body text, and the private API maps every returned field
explicitly without spreading the delivery row. No `fragmentText`, `promptContext`, `appSecret`,
`tenantAccessToken`, secret value, or generated `.tmp-iris-*` test artifact is present in the
intended worktree.

## CI And Deployment Evidence

- Candidate SHA: `adac01cd2d2f4cd2ef01ed089a60719efa354629`.
- Draft PR: <https://github.com/xfbbert-dotcom/iris/pull/23>, stacked on
  `codex/iris-chat-knowledge-drafts`, open and draft.
- Core CI: success for the exact candidate SHA,
  <https://github.com/xfbbert-dotcom/iris/actions/runs/30746470862/job/91492812254>.
- AI Worker CI: success for the exact candidate SHA,
  <https://github.com/xfbbert-dotcom/iris/actions/runs/30746470862/job/91492812226>.
- PostgreSQL backup identifier: `iris-20260802T115722Z.bundle.tar.age` (28,228,520 bytes),
  completed before migration.
- Migration `0045_answer_source_citations.sql`: present in production `schema_migrations`.
- Core/AI Worker image SHA parity: `iris-core:adac01cd2d2f4cd2ef01ed089a60719efa354629`
  and `iris-ai-worker:adac01cd2d2f4cd2ef01ed089a60719efa354629`.
- Private candidate status and live readiness: healthy and `ready`; mention replies enabled with no
  unavailable reason while runtime remains globally disabled.
- Public `/health=200`: passed during the bounded disabled-ingress check.
- Public `/internal/answer-replies/feishu/probe=404`: passed during the same check.
- Real citation result: pending.
- Permission-revocation result: pending.
- Current queue/DLQ and answer-reply counts: event/document/reindex pending and DLQ counts are zero;
  `unresolvedCount=0`, `pendingSafeNoticeCount=0`, and `reconciliationRequiredCount=0`.
- Current runtime/Caddy state: `globalEnabled=false`, `desiredGlobalEnabled=false`, Caddy stopped.
- Approved production marker remains `b25d8298fd396366c97449dfbe6f11f3dc42f8f9`; the candidate has not
  been promoted.

Real Feishu acceptance remains open. The next single human action is to create a new Wiki page
titled `Iris Citation Pilot 2026-08-02 2010 CST`, put
`IRIS-CITATION-PILOT-20260802-2010-CST` plus bounded non-sensitive test text in its body, share that
page with the Iris app, and return its canonical Feishu URL. Iris remains fail-closed until that
fixture exists. PR #22 and this draft PR remain unmerged pending explicit authorization.
