# Iris Permission-Safe Answer Citations

## Scope

This stacked change adds deterministic source citations and durable, content-minimized answer-reply
receipts to the existing Feishu mention-answer path. It is based on
`codex/iris-chat-knowledge-drafts` and does not merge or replace PR #22.

- Renders at most three cited sources in prompt rank order with the exact Iris reference footer.
- Captures immutable source snapshot, fragment, chunk, hash, title, and canonical URI metadata.
- Rechecks live source permission immediately before sending a prepared answer.
- Atomically blocks delivery when initial retrieval denies a source inside the prompt-ranked
  window, without creating a false source trace for denied content.
- Skips the model/provider entirely for a prompt-ranked denial, preventing provider fallbacks from
  turning lower-ranked backfill into a normal answer.
- Clears prepared answer text on every terminal transition while retaining only fingerprints and
  content-free source/event evidence.
- Replays a previously prepared or sent receipt without another model call or duplicate answer.
- Re-inspects prompt permissions before resuming an unsent prepared receipt and can atomically block
  an older source-less receipt without regenerating or replacing its answer.
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

- Candidate SHA: `5b54dfe9ac4819bcec8a434a19cac8232a9e5315`.
- Draft PR: <https://github.com/xfbbert-dotcom/iris/pull/23>, stacked on
  `codex/iris-chat-knowledge-drafts`, open and draft.
- Core CI: success for the exact candidate SHA,
  <https://github.com/xfbbert-dotcom/iris/actions/runs/30783815666/job/91593450630>.
- AI Worker CI: success for the exact candidate SHA,
  <https://github.com/xfbbert-dotcom/iris/actions/runs/30783815666/job/91593450673>.
- Evidence-only commit `5ac7fb97d7a44f1b1a9cfb1e445523c9ca369200` changed only Task 8
  reporting/plan documents and passed Core and AI Worker CI in
  <https://github.com/xfbbert-dotcom/iris/actions/runs/30747404889>. It was not deployed over the
  exact candidate images.
- PostgreSQL backup identifier: `iris-20260802T115722Z.bundle.tar.age` (28,228,520 bytes),
  completed before migration.
- Migration `0045_answer_source_citations.sql`: present in production `schema_migrations`.
- Core/AI Worker image SHA parity: `iris-core:5b54dfe9ac4819bcec8a434a19cac8232a9e5315`
  and `iris-ai-worker:5b54dfe9ac4819bcec8a434a19cac8232a9e5315`.
- Private candidate status and live readiness: healthy and `ready`; mention replies enabled with no
  unavailable reason while runtime remains globally disabled.
- Public `/health=200`: passed during the bounded disabled-ingress check.
- Public `/internal/answer-replies/feishu/probe=404`: passed during the same check.
- Real citation result: passed before the revocation incident and was retained as historical
  evidence; the recovery window did not repeat the authorized-answer provider call.
- Permission-revocation result: passed on the exact candidate SHA. The fresh delivery reached
  `permission_blocked`, made zero answer-send attempts, sent one safe notice, and did not expose the
  revoked marker or a normal citation block in the latest visible Feishu reply.
- Current queue/DLQ and answer-reply counts: event/document/reindex pending and DLQ counts are zero;
  `unresolvedCount=0`, `pendingSafeNoticeCount=0`, and `reconciliationRequiredCount=0`.
- Post-revocation cleanup state at that checkpoint: `globalEnabled=false`,
  `desiredGlobalEnabled=false`, Caddy stopped.
- The production marker before the controlled restoration remained
  `b25d8298fd396366c97449dfbe6f11f3dc42f8f9`. The recovery candidate had not yet been restored to
  the daily pilot at that checkpoint.

An independent recovery audit on 2026-08-02 rechecked the VPS repository and image SHA, tracked
cleanliness, healthy private services, encrypted backup ordering, migration count, private
readiness, unknown-receipt 404, and every required zero count. It then repeated the bounded public
check once from the operator machine (`/health=200`, private answer-reply path `=404`) and restored
the same fail-closed state. No model or Feishu event probe was used. A content-free database check
found zero sources with the prescribed pilot title and zero answer delivery/source/event rows.

## 2026-08-03 Revocation Incident And Recovery

The real pilot subsequently created an isolated Wiki fixture and completed the authorized-answer
half of the gate. After Iris access was revoked, the live permission guard correctly denied the
fixture and excluded it from the second prompt. The durable source order proved the denied rank
disappeared and lower-ranked allowed fragments shifted forward. However, Core then sent an ordinary
answer based on that backfill. The reply was immediately recalled. Its exact body is unavailable;
the evidence does not prove that the revoked marker itself was emitted.

The root cause was a dropped boundary signal: retrieval returned `deniedDocumentIds`, but the
mention responder and durable delivery service persisted only allowed prompt traces. This recovery
propagates only prompt-ranked denied IDs on a separate bounded field. PostgreSQL now writes
`prepared` and `permission_blocked` in one transaction, clears prepared text, records zero answer
attempts, skips the verifier/send path, and sends only the existing deterministic safe notice. The
answer orchestrator also skips the model/provider request whenever that denied set is non-empty, so
capacity, blank-answer, and invalid-response fallbacks cannot bypass the block. Denied content
remains absent from source traces and receipts.

Independent review then found a cross-instance replay edge: the separate denied IDs were not part
of the existing-record decision. The repository now atomically upgrades only an unsent prepared
delivery even if the blocked candidate's semantic fingerprint differs, while preserving the stored
answer fingerprint and source facts. It reuses exact denied facts without appending an event,
rejects changed denial facts after blocking, and requires each permission event to contain either
prompt-trace IDs or external preflight IDs, never both. A second review found that an already
prepared receipt bypassed the new prompt-denial path. The delivery service now performs a fresh
permission-only prompt inspection before resuming that receipt, without invoking the answer model.

The final repository review also found overlapping replay IDs could double-count or violate trace
order. The repository now chooses one provenance class from persisted prompt order; real
PostgreSQL tests cover overlap, mixed IDs, reverse order, and exact replay.

Current post-review recovery verification includes 273 focused in-memory tests, all 78
answer-repository PostgreSQL tests, typecheck, and the complete standard root `npm run verify` gate
(273.5 seconds), all passing. Exact-SHA Core and AI Worker CI passed for
`5b54dfe9ac4819bcec8a434a19cac8232a9e5315`. The same SHA was deployed to both private images and
completed the fresh Feishu revocation gate described below. PR #22 and this draft PR remain
unmerged pending explicit authorization.

## 2026-08-03 Exact-SHA Revocation Acceptance

The real gate used only the existing approved pilot group and one fresh incoming Feishu message.
It was protected by a 20-minute root-owned automatic fail-closed timer. All 13 non-pilot groups
remained disabled, `proactiveSpeech=false`, and Caddy was started last only after the private
runtime inventory matched the bounded profile. Public `/health` returned `200` and the private
answer-reply route returned `404` through Caddy.

- Incoming message ID: `om_x100b6833bc5158a0b3042eda0e9f8dd`.
- Delivery ID: `answer-reply-3a01e3d44fc5bd16f040cbfc5261381916b5d21ab885089351671e1f98e56cf9`.
- Safe-notice message ID: `om_x100b6833bd0f28a8b103c6ef4d57275`.
- Revoked source ID: `ebd9370f-32e7-40e2-81c2-2a4fa65de1f4`.
- Delivery state: `permission_blocked`; answer attempts: `0`; safe-notice attempts: `1`.
- Event order: `prepared`, `permission_blocked`, `safe_notice_send_started`, `safe_notice_sent`.
- The revoked source ID appeared only in the permission event and was absent from all persisted
  source traces. The private receipt exposed no answer or fragment body.
- The latest visible Feishu segment contained the deterministic permission notice, did not contain
  the revoked marker, and did not contain the normal citation footer.
- The execution-ledger runtime is disabled in this deployment profile. A direct content-free table
  query found zero provider, turn, or permission lifecycle rows for this incoming message; the
  isolated exact-image gate separately recorded `modelCalls=0` for the same denied path.

Cleanup stopped Caddy first, durably disabled global runtime and all 14 known groups, restored
`proactiveSpeech=false`, recreated Core fail closed, and removed the transient timer. Final Core,
AI Worker, PostgreSQL, and Redis health was `healthy`; event/document/reindex pending and DLQ counts
were all zero; answer-reply unresolved, pending-safe-notice, and reconciliation-required counts were
all zero. The terminal receipt remained unchanged with one safe notice and zero answer attempts.

## 2026-08-03 Controlled Daily Pilot Restoration

After all ten product-level loops in the internal MVP checklist were confirmed green, the existing
single-group daily pilot was restored on the exact behavior candidate
`5b54dfe9ac4819bcec8a434a19cac8232a9e5315`. Core and AI Worker both use images tagged with that
SHA. The draft PR head is the evidence-only commit
`abcdedf95bf0119adc157bcb331394890a72f11c`; its Core and AI Worker checks both passed in
<https://github.com/xfbbert-dotcom/iris/actions/runs/30814649624>.

The preflight was fail closed: live and desired global runtime were false, all 14 known groups were
disabled, Caddy was stopped, readiness was `ready`, persistence was healthy PostgreSQL, and every
event, answer-reply, document, reindex, memory, and projection-repair pending/DLQ count was zero.
The existing environment already matched the approved daily profile: memory extraction enabled,
thread/action extraction allowlisted only to `oc_637a9aca45f01943477f4e17f1fc5b9a`, proactive planner
and delivery disabled with empty allowlists, knowledge cards disabled with an empty allowlist, and
wiki-space sync enabled.

Activation enabled only the approved pilot group, durably enabled global runtime, verified all
capability switches, and started Caddy last. The final bounded profile is:

- `globalEnabled=true`, `desiredGlobalEnabled=true`, PostgreSQL persistence healthy;
- the pilot group enabled and the other 13 known groups disabled;
- group context, mention replies, group documents, and knowledge-base retrieval enabled;
- `proactiveSpeech=false`, `generateKnowledgeDrafts=false`, `writeKnowledgeBase=false`, and
  `callExternalTools=false`;
- memory extraction enabled/running/worker-healthy with exactly one thread and action group;
- one wiki space synced with no pending, retry, dead-letter, or disabled space;
- all event, answer-reply, document, reindex, memory, and projection-repair counts still zero;
- Core, AI Worker, PostgreSQL, and Redis healthy; Caddy running;
- public `/health=200` and public `/internal/status=404`.

No model probe or synthetic Feishu message was sent during this restoration. PR #22 and PR #23
remain open and unmerged pending explicit merge authorization.

## 2026-08-04 Current-Topic Retrieval Regression

A controlled multi-user pilot question depended only on the immediately preceding group
discussion. The full 20-message retrieval query also contained an older revoked acceptance topic,
so the intentionally strict denied-source preflight produced `permission_blocked`, made zero
ordinary answer attempts, sent one safe notice, and disclosed no revoked content. This was safe but
not usable.

The root cause is topic-window coupling, not the permission guard. The model prompt should keep its
20-message live-chat anchor, while document retrieval should not let a stale sixth message redirect
an unrelated current-topic search. The focused fix limits only retrieval-query chat augmentation to
the latest five messages. It leaves prompt context, prompt-ranked denial propagation, send-time
permission revalidation, and safe-notice behavior unchanged.

TDD evidence on the working tree:

- the new regression first failed because the stale sixth message remained in `queryText`;
- the same test then passed after the bounded current-topic window was applied;
- 185 orchestrator/runtime/delivery tests, 48 Feishu responder tests, and TypeScript typecheck
  passed before the full repository gate;
- the complete root `npm run verify` gate passed in 305.3 seconds;
- exact-SHA CI, deployment, and a fresh real Feishu answer remain pending at this checkpoint.
