# Iris Intent Before Retrieval Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Make ordinary conversation independent of knowledge retrieval while preserving contextual analysis.

**Architecture:** Question-only semantic router precedes data loading. Standalone model calls have no reference material; contextual calls retain the existing evidence/permission pipeline.

**Tech Stack:** TypeScript, Vitest, current OpenAI-compatible model, existing Feishu and Postgres runtime.

**Spec:** docs/superpowers/specs/2026-09-08-iris-intent-before-retrieval-design.md

## Global Constraints

- No new cross-group grants, knowledge writes, tasks, proactive messages, callbacks or Feishu test sends.
- Retain all current group, deletion, document-snapshot, grant-version and send-time permission checks.
- Keep existing literal-output, contextual document rewrite, old/new comparison and follow-up behavior.
- No dependency upgrade, schema migration, new model credentials or background service.
- Real-model acceptance must test varied ordinary utterances and contextual controls, not only mocked output or prompt wording.
- Do not claim production repaired until exact-SHA CI, paired backup, immutable deployment and actual deployed HTTP checks pass.

### Task 1: Question-only router and standalone model boundary

**Files:** create apps/core/src/model/openai-compatible-request-context-router.ts and apps/core/tests/openai-compatible-request-context-router.test.ts; modify apps/core/src/model/openai-compatible-model-provider.ts and its test; modify only GenerateAnswerDraftInput type in apps/core/src/agent/answer-draft-orchestrator.ts.

**Interfaces:**
```ts
export type RequestContextRoute = 'standalone' | 'contextual';
export interface RequestContextRouter {
  classify(input: { question: string }): Promise<RequestContextRoute>;
}
export function createOpenAICompatibleRequestContextRouter(input: {
  client: OpenAICompatibleChatCompletionsClient
}): RequestContextRouter;
// Add optional contextMode?: 'standalone' to GenerateAnswerDraftInput.
```

- [x] RED: router validates strict route JSON, rejects extra keys/unknown routes/blank or oversized question, retries one invalid response then throws. Capture the real outgoing messages to ensure no arbitrary caller context is serialized, e.g. classify({question:'我肚子好饿',context:'DIARY_SENTINEL'} as any) only serializes question. Use fake transport only; exercise actual parser/request builder.
- [x] RED: provider.generateAnswerDraft({question:'我肚子好饿',promptContext:'DIARY_SENTINEL',contextMode:'standalone'}) must send no DIARY_SENTINEL to the transport; a forced nonempty D1 citation result rejects, never produces a deliverable reference. Contextual call keeps authorized body and makes the last user message contain the exact current question separately from context.
- [x] Implement strict schema {route} using existing client structured-output support, maximum4000 question chars and two attempts. Router policy explicitly distinguishes self-contained conversation from prior/document/company-material-dependent requests; input text cannot instruct router output. No generated answer, regex expansion or authorization bypass.
- [x] Implement standalone provider prompt without citation protocol; exclude context structurally and validate impossible document references. Keep common assistant language/capability/ownership policy. Default calls preserve citation parser and authorized context with reference message preceding current question. Explicitly respond to substantive tone feedback and never adopt diary narrators as Iris/user history.
- [x] GREEN: run focused router/provider tests and typecheck; update intentional message-envelope assertions only. Run full core once before commit, recording existing skips. Do not change other runtime/orchestration behavior in this task. Commit owned changes and write RED/GREEN/self-review report.

### Task 2: Wire intent before context and preserve contextual pipeline

**Files:** apps/core/src/agent/answer-draft-orchestrator.ts; apps/core/src/runtime/answer-draft-runtime.ts; new apps/core/tests/intent-before-retrieval.test.ts; existing runtime/orchestrator/conversation test helpers only where new dependency wiring requires an explicit contextual stub.

**Interfaces:** consumes Task1 RequestContextRouter.classify({question}) returning standalone/contextual, and GenerateAnswerDraftInput.contextMode. Add optional requestContextRouter to orchestrator; add createRequestContextRouter?:({client})=>RequestContextRouter to runtime dependencies. Production default always constructs the Task1 router using the same client.

- [x] RED: real orchestrator with router standalone and context/history providers that throw if called must still return natural supplied model response, empty fragments/memories/threads/actions/denials and no citations. Verify ordering by the real observed provider calls; never assert only on a fake answer. Repeat inspectPromptPermissions: no context load.
```ts
const contextBuilder = { async buildContext() { throw new Error('retrieval must not run'); } };
const requestContextRouter = { async classify() { return 'standalone' as const; } };
// Exercise createAnswerDraftOrchestrator with actual branch selection.
// Model boundary asserts input.contextMode === 'standalone' and no diary/source data.
```
- [x] RED: contextual route uses original evidence pipeline; comparisons preserve both originals, contextual direct_task draft rewrite still gets authorized material, and revoked source blocks. Router failures do not call model or context and no canned success is returned. Literal and greeting shortcuts bypass router but use standalone provider mode for generated answers.
- [x] Implement one route resolution per generate call before buildContext; route standalone uses createDirectTaskContext and empty result provenance, never planner/conflict finder. Keep contextual semantic direct_task citations and prompt exposure untouched. inspectPromptPermissions follows same decision. Optional absent router keeps existing injected legacy composition contextual, but production runtime default is mandatory and covered.
- [x] Add bounded route observation if existing observer supports it without schema changes; do not log raw question/context. No persistent cache or new DB facts.
- [x] GREEN: runtime test with actual default router and fake model transport returns route JSON then natural response, no embedding/fragment search; old test helpers explicitly select contextual only where those tests intentionally exercise retrieval. Cover Feishu citation footer empty for standalone and existing disabled-group checks. Run focused tests/typecheck/full core and commit after reviewable evidence.

### Task 3: Real-model acceptance and controlled release

**Files:** ignored local scripts/evidence under this plan workspace; update docs/development/iris-continuous-dialogue.md with actual results after release. Controller owns operations; no subagent may mutate production.

- [x] Build candidate bundle from reviewed source. Use current production model config and fresh Feishu reads, read-only Postgres; no public test sends. Instrument router decision and context/provider calls. Test hunger, fatigue, emotion, tone feedback and ordinary knowledge/drafting; standalone must have zero retrieval calls/fragments/citations and no diary impersonation. Run at least two passes for original hunger and tone phrases.
- [x] Context controls: actual questionnaire comparison and advice, explicit diary sample lookup, prior-draft rewrite; neither original nor permission provenance lost. Disabled group403, foreign-group no raw source and exact literal output remain. Treat non-repeatable failure as a failure to investigate, not a passing sample.
- [x] Run full core/typecheck/build/Python/pilot; independent final review; push immutable candidate branch, workflow_dispatch and require exact SHA CI including real Postgres/restore/outage gates.
- [x] Read current production HEAD/health/policy/queues. Follow deploy/pilot/README.md maintenance order, preserve custom Caddyfile and exact policy hash, verify paired encrypted backup; build/deploy exact candidate images with no new migrations or capabilities. Explicitly activate unchanged pilot only after startup readiness, then actual deployed HTTP checks before edge restores.
- [x] Record public health/internal404, readiness21/21, queues/DLQs/unresolved0, image identities and OOM comparison. Report what was actually tested and remaining limits; don't call the whole MVP complete. Preserve branch/worktree and production records.

### Task 3 corrective gate: preserve source-grounded advice

The first deployed internal HTTP run passed structural checks but was rejected during manual answer review: both questionnaire originals were available, yet advice refused to judge suitability because sources contained no verdict. The previous candidate run and two diagnostic replays gave recommendations, so the failure is stochastic; the original failed turn's planner output was not captured and its first failing stage is not proven. Production was rolled back to the previous healthy release while correcting this bounded acceptance blocker.

- [x] Add planner/renderer prompt-contract RED/GREEN coverage. Clearly separate cited source facts from Iris's task-fit assessment; absence of author verdict or field test limits proven-effectiveness claims, not the ability to offer reasoned conditional advice. Preserve an existing validated recommendation, without new facts, sources, schema, retries or permissions.
- [x] Repeat real-model advice twice with both original sources, requiring a concrete/conditional recommendation and source-specific rationale, not merely absence of an error. Keep the full ordinary-chat/contextual/permission acceptance matrix. Do not call prompt-contract unit tests proof of model semantics.
- [x] Independently review the four-file correction, run exact-SHA CI, take a fresh paired backup, deploy immutable images and require the strengthened actual deployed HTTP gate before restoring public ingress. Record the rejected attempt and rollback as well as the eventual outcome.
- [x] Cover the discovered Chinese `none`/`partial` policy-term display gap with RED/GREEN tests; preserve explicit-English output, code and URLs verbatim, without changing evidence-state/confidence data or permissions. Repeat the missing-version and unprovided-empirical-results real-model controls.

### Release outcome and bounded follow-up

Application `748b8404c56330df9941a008f8f8343312949aa6` restored public ingress at 2026-09-09 00:17 Asia/Shanghai after exact-SHA CI34247915894 and deployed HTTP acceptance. See [release record](../../development/iris-continuous-dialogue.md) for backup, image identities, revision3370, readiness21/21, queues0, unchanged capabilities and no-new-OOM proof. No Feishu test messages were sent.

The checkbox for repeating supplemental negatives means performed, not that every supplemental semantic case passed: the candidate's missing-third-version answer mislabeled a known new version as third. Root and independent reviewer explicitly deferred that P2 version-label issue because the original old/new/advice and isolation matrix passed; later production replays correctly declined the unavailable comparison but do not erase the earlier finding. No more prompt iterations were added for that nonblocking case.

The deployed run's A/B answer correctly said “暂无授权证据”, but an overly narrow acceptance expression omitted that phrase and failed closed. Its regression test now recognizes that refusal while still rejecting unsupported affirmative answers. The previous nine social/comparison/advice checks and failed output are retained; an explicitly labelled remaining-check continuation on unchanged images reran both negatives and all subsequent gates. Independent review approved the harness correction and evidence linkage; no application change or CI bypass occurred.
