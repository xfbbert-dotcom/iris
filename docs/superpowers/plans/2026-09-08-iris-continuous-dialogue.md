# Iris Continuous Dialogue Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore natural question answering and source-aware consecutive analysis in the current pilot.

**Architecture:** Extend the existing evidence planner and fresh current-chat context provider. Preserve source bundles and bounded substantive text across prompt/planning boundaries. Reuse existing sent-answer identities for conversational continuity without treating generated answers as facts.

**Tech Stack:** TypeScript, Vitest, Postgres, Feishu OpenAPI, current OpenAI-compatible model.

**Spec:** docs/superpowers/specs/2026-09-08-iris-continuous-dialogue-design.md

## Global Constraints

- Current group only for raw messages; no cross-group raw-chat grant or capability expansion.
- Fresh Feishu bodies only for historical identities; stored content is not an authorization.
- Knowledge writes, tasks and proactive speech retain existing gates and approval contracts.
- Keep exact-literal output, greeting, denied-source and disabled-group controls working.
- Normal Chinese answers must not expose internal conjecture/confidence policy tokens.
- No schema migration, dependency upgrade, public test message or fabricated callback is needed.

## Task 1: Natural task routing and substantive source analysis

**Files:** agent/answer-draft-orchestrator.ts; model/openai-compatible-evidence-planner.ts;
model/openai-compatible-grounded-answer-renderer.ts; model/openai-compatible-model-provider.ts;
memory/context-assembly.ts; associated tests (all below apps/core/src or apps/core/tests).

**Interfaces:** consumes existing EvidencePlan union and LiveChatMessage. Add optional
`role?: "user" | "assistant"` to LiveChatMessage; assistant is conversational context, excluded
from Cn factual evidence. Keep general planner taskMode direct_task fields null/empty as existing
parser requires. Produces natural direct_task execution with already authorized prompt context.

- [ ] RED: parser/client fixture returning `{taskMode:"direct_task",evidenceState:null,premises:[],proposedAnswer:null,missingInformation:[],confidence:null}` must reach normal model through the real orchestrator for `开放式问题和封闭式问题有什么区别？`, not throw company_fact-only or render no-evidence.
- [ ] RED: a 4600-character source with a distinctive later-section witness must reach the planner and renderer when retained as relevant context; unrelated document item limits remain enforced.
- [ ] Implement the existing semantic task union end-to-end. Current question is the task; previous content cannot override system rules. Direct-task answer may use authorized context but not invent company facts/citations. Group-material comparison remains grounded inference; general recommendations are explicitly suggestions. Missing source answers identify the useful gap naturally.
- [ ] Use one shared bounded analysis-text policy for live source items: at most 8000 characters per retained message, aggregate 24000 live characters in planner input; preserve 20 context/10 planner counts and 1200 background-document item cap. Trim with a visible marker and avoid claiming full-source completeness when clipped. Keep source facts and assistant output separate.
- [ ] GREEN: run focused planner/renderer/orchestrator/context tests plus typecheck. Update intentional old company_fact-only contract assertions, not unrelated expectations. Record exact RED/GREEN commands and output, self-review, commit only owned files.

## Task 2: Source-bundle selection

**Files:** apps/core/src/memory/topic-aware-chat-window.ts; apps/core/tests/topic-aware-chat-window.test.ts.

**Interfaces:** existing generic `selectTopicAwareChatWindow<T>(messages, question, limit):T[]`, no callsite changes. Optional role metadata from task1 is tolerated; assistant output cannot outrank human source bundles.

- [ ] RED fixture: old original+reply label, new original+reply label, then15 noise posts, call limit10 and expect all four source IDs; duplicate labels for newer original cannot crowd out the old bundle.
- [ ] Preserve up to two distinct relevant original/label bundles in at most four protected slots; dedupe bundles by fresh parent/root identity. Keep input chronology, honor smaller limits, fill remaining slots with latest context. A relevant long standalone original is a source candidate too. Do not introduce questionnaire-specific terms.
- [ ] GREEN: existing single-source, literal/current-question exclusion, identity dedupe, no-topic and limit cases remain correct; record RED/GREEN and commit only owned files.

## Task 3: Fresh same-chat follow-up recall and assistant continuity

**Files:** memory/live-chat-context-provider.ts; memory/historical-chat-query.ts;
feishu/feishu-chat-history-reader.ts; runtime/answer-draft-runtime.ts; new focused helpers/tests as needed.

**Interfaces:** existing provider input remains chatId/limit/question. Fresh history messages gain
optional assistant role only for exact configured Iris app or exact verified sent-reply identities.
Reader defaults remain human-only. SQL uses bound parameters and current-chat identity.

- [ ] RED fixture: recent human anchor `昨天发的问卷讲了什么` plus current material; undated comparison must recover old original outside100, not only label. Query terms derive from current subject and relevant recent dated anchor. A generic no-anchor query makes no historical read.
- [ ] Extend follow-up recall with max2 distinct date anchors, eight total candidate IDs plus eight total one-hop parents, fresh bodies and tombstones. Resolve prior relative dates at prior sentAt. Preserve denied-ID override across merged windows and exclude foreign sources. Use current recent context alongside dated sources.
- [ ] RED fixture: own verified sent answer plus `再简短一点` survives as assistant conversation context; a foreign bot, another-chat reply, deleted answer or denied underlying document does not. The assistant reply is not Cn factual evidence.
- [ ] Add bounded own-answer continuity via existing delivery identities and live read, with source permission revalidation where applicable. Do not accept arbitrary app messages or cached generated text as facts.
- [ ] GREEN: focused reader/provider/runtime and real-Postgres candidate tests; source body unchanged and no persistence writes. Record RED/GREEN and commit owned files after review.

## Task 4: Integration, release and acceptance

**Files:** focused integration tests, architecture/live-chat docs, ignored local acceptance evidence.

- [ ] Run source comparison end-to-end with both complete pilot originals through real Feishu and real model, no injected substitute source. Assert later-section witness and both source IDs in planner, Chinese comparison/analysis, no policy words or fabricated claims.
- [ ] Check ordinary knowledge, general drafting and subsequent rewrite, missing-version clarification, cross-group negative control, disabled group403, source-denial and exact output behavior.
- [ ] Run typecheck/build/core/Python/pilot suites, review task diffs and whole branch, push exact commit and wait for CI.
- [ ] Confirm production commit/runtime policy/queues, create paired backup in maintenance, deploy immutable exact-SHA images, verify safe-off/startup and deliberately restore unchanged pilot controls.
- [ ] Recheck deployed HTTP answers and health/queues/readiness/public health; record actual results and boundaries. Do not claim a Feishu group test unless one really occurred.
