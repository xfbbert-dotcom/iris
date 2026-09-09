# Iris Shared Working Chat Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Existing pilot groups can ask about each other's ordinary discussion without Wiki publication or per-message approval.

**Architecture:** Versioned exact group scope gates fresh raw-chat retrieval. External chat provenance persists through generation, delivery and assistant reuse; final-send and revocation share transaction locks. Existing document grants and action capabilities remain separate.

**Tech Stack:** TypeScript, Fastify, PostgreSQL, Vitest, existing Feishu HTTP readers.

**Spec:** `docs/superpowers/specs/2026-09-09-iris-shared-working-chat-design.md`

## Global Constraints

- No implicit grants from bot membership, request-supplied groups, common users or Wiki visibility.
- Scope only changes raw working-chat answering; do not enable Wiki writes, proactive speech, tasks, or cross-group semantic memory/thread/action projections.
- Maximum 5 groups; total prompt 20 messages, planner 10 chat evidence, 8,000 chars/message and 24,000 original-text chars; history candidates 8 and one-hop parents 8 globally.
- Default undated topic recall is 30 days; fresh Feishu message body and local tombstones dominate stored bodies.
- Source and destination must be enabled and accessible. Trace every model-exposed external message and propagate underlying traces through assistant rewrites.
- No production writes during implementation; exact pilot activation is a separate acceptance step. Do not send test chat messages or manufacture approvals/callbacks.
- Use TDD; run focused RED/GREEN then affected regressions. Keep four documentation dispositions with actual validation/deployment level.

---

### Task 1: Versioned scope and durable permission contracts

**Files:**
- Create: `apps/core/migrations/0058_shared_working_chat.sql`
- Create: `apps/core/src/shared-chat/working-chat-scope.ts`
- Create: `apps/core/src/shared-chat/postgres-working-chat-scope-repository.ts`
- Create: `apps/core/tests/working-chat-scope.test.ts`
- Create: `apps/core/tests/postgres-working-chat-scope.test.ts`

**Interfaces:**

```ts
export type WorkingChatScope = {
  id: string; version: number; state: "active" | "revoked";
  groups: { chatId: string; name: string }[];
  updatedAt: Date; updatedBy: string;
};
export type SharedChatSourceBinding = {
  scopeId: string; scopeVersion: number; sourceChatId: string;
  destinationChatId: string; messageId: string; contentHash: string;
};
export interface WorkingChatScopeRepository {
  get(): Promise<WorkingChatScope | undefined>;
  replace(input: { expectedVersion: number; state: "active" | "revoked";
    groups: WorkingChatScope["groups"]; updatedBy: string; at: Date }): Promise<WorkingChatScope>;
  resolveForChat(chatId: string): Promise<WorkingChatScope | undefined>;
  validateExact(binding: SharedChatSourceBinding): Promise<boolean>;
}
export function hashSharedChatText(text: string): string;
export type SharedChatSourceVerifier = {
  verify(input:{chatId:string;sources:readonly SharedChatSourceBinding[]}):Promise<boolean>;
};
```

Use singleton scope ID `pilot-working-chat`; version 0 means absent only. Table `working_chat_scopes` has id/version/state/groups jsonb/updated_at/updated_by. Export reusable transaction helper `lockSharedChatSources(queryable, bindings, destinationChatId)` which checks exact scope, durable runtime and tombstones under locks and throws `WorkingChatScopeStaleError`. Use existing `lockConversationMessageIngestScope` for message locking. Stable lock order: scope, runtime, sorted message identities; caller acquires delivery last. Scope replace shares scope lock and rejects related `sending` / `reconciliation_required` deliveries.

Migration also reserves `answer_reply_chat_source_traces(delivery_id, trace_index, scope_id, scope_version, source_chat_id, destination_chat_id, message_id, content_hash)` with delivery FK and unique delivery/trace index, no text body. Add `chat_provenance_version smallint` nullable to answer deliveries, leaving legacy rows distinguishable. Task 3 writes/reads these tables; Task 1 must not edit existing answer repository.

- [ ] Step 1: Write RED tests through real repository with disposable Postgres (existing integration helper pattern); also pure validation tests for malformed/duplicate/oversized group arrays, blank actor, invalid CAS and hash stability.

```ts
expect(await repo.resolveForChat("group-b")).toBeUndefined();
const scope = await repo.replace({ expectedVersion: 0, state: "active",
  groups: [{chatId:"group-a",name:"A"},{chatId:"group-b",name:"B"}],
  updatedBy:"operator", at:new Date("2026-09-09T00:00:00Z") });
expect(scope.version).toBe(1);
expect((await repo.resolveForChat("group-b"))?.groups.map(g=>g.chatId)).toEqual(["group-a","group-b"]);
expect(await repo.resolveForChat("group-c")).toBeUndefined();
await expect(repo.replace({expectedVersion:0,state:"revoked",groups:scope.groups,updatedBy:"operator",at:new Date()})).rejects.toThrow();
```

- [ ] Step 2: Run `npm --workspace apps/core test -- --run tests/working-chat-scope.test.ts tests/postgres-working-chat-scope.test.ts`; retain expected missing-implementation failure, not only skipped DB tests.
- [ ] Step 3: Implement normalization, durable CAS and lock helper. Hash is SHA-256 of trimmed text with CRLF normalized to LF. Scope group membership must be checked before fresh message retrieval in later tasks.
- [ ] Step 4: Run same tests with available disposable Postgres, verify restart persistence, revoke/rejoin version mismatch and send-in-flight conflict. Record unavailable infrastructure separately, never count skips as pass.
- [ ] Step 5: Self-review, run typecheck and commit explicit files as `feat(core): add versioned working chat scope`.

### Task 2: Bounded shared retrieval and source attribution

**Files:**
- Modify: `apps/core/src/memory/live-chat-context-provider.ts`
- Modify: `apps/core/src/memory/context-assembly.ts`
- Modify: `apps/core/src/memory/topic-aware-chat-window.ts`
- Modify: `apps/core/src/agent/answer-draft-orchestrator.ts`
- Modify: `apps/core/src/memory/document-retrieval-context.ts`
- Modify: `apps/core/src/model/openai-compatible-evidence-planner.ts`
- Modify: `apps/core/src/model/openai-compatible-grounded-answer-renderer.ts`
- Modify: `apps/core/src/feishu/feishu-chat-history-reader.ts` (type propagation only)
- Create: `apps/core/tests/shared-working-chat-context.test.ts`
- Extend: `apps/core/tests/topic-aware-chat-window.test.ts`, `apps/core/tests/assistant-source-lineage.test.ts`

**Interfaces:**

Consume Task 1 types. Add optional `sharedChatScopes: Pick<WorkingChatScopeRepository,"resolveForChat"|"validateExact">`, `canReadChat(chatId:string):Promise<boolean>`, and `sharedChatVerifier: SharedChatSourceVerifier` to provider dependencies. Task 1 owns the pure verifier interface; Task 3 implements it. Invoke verifier once for the final selected source union before exposing context, rather than repeating full remote validation for every selection stage. Add optional sourceChatId/sourceChatName/sourceSentAt (ISO string), sharedChatSource and underlyingChatSources to LiveChatMessage; preserve these in every mapping. AnswerDraft result includes optional `sharedChatSources: SharedChatSourceBinding[]` containing all exposed external source bindings and transitive assistant bindings, not only Cn citations.

- [ ] Step 1: Add RED tests with fake external reader and real provider: ordinary A-group original can answer B request, outsider never read, same speaker cross-group label never binds, two documents fit global bounds, denied fresh read has no DB body fallback.

```ts
const messages = await provider.loadRecentMessages({chatId:"group-b",question:"A 群之前的问卷主要讨论了什么？"});
expect(messages.some(m=>m.sourceChatId==="group-a" && m.text.includes("12 个主问题"))).toBe(true);
expect(messages.every(m=>m.sourceChatId!=="group-c")).toBe(true);
expect(messages.length).toBeLessThanOrEqual(20);
expect(messages.filter(m=>m.sourceChatId==="group-a").every(m=>m.sharedChatSource?.destinationChatId==="group-b")).toBe(true);
```

- [ ] Step 2: Run `npm --workspace apps/core test -- --run tests/shared-working-chat-context.test.ts tests/topic-aware-chat-window.test.ts`; confirm RED for absent sharing, not fixture typo.
- [ ] Step 3: Load current chat anchors, resolve exact server scope, select relevant permitted source chats. Add undated keyword SQL ID candidates constrained to 30 days and exact source groups; dated recall continues exact date. A no-topic cross-group recap (test `其他群最近聊了什么？`) must read up to20 recent messages from each selected permitted external group then share global20/10 selection, not only return the destination anchor. Fresh-read IDs, ignore foreign source mismatches, filter tombstones, recheck scope before exposing. Preserve global budgets and current standalone path. Emit bounded group/time source labels to planner and final prompt; keep question text as data, not authorization.
- [ ] Step 4: Regress historical/followup/live-history/intent-before-retrieval and planner/renderer suites. Test all external messages (including uncited labels) appear in result provenance and nested assistant provenance survives clone/dedupe.
- [ ] Step 5: Self-review, typecheck and commit explicit files as `feat(core): retrieve scoped shared working chat`.

### Task 3: Shared provenance in delivery and assistant reuse

**Files:**
- Create: `apps/core/src/shared-chat/shared-chat-source-verifier.ts`
- Modify: `apps/core/src/answer-replies/answer-reply-repository.ts`
- Modify: `apps/core/src/answer-replies/postgres-answer-reply-repository.ts`
- Modify: `apps/core/src/answer-replies/answer-reply-receipt-validator.ts`
- Modify: `apps/core/src/answer-replies/answer-reply-delivery-service.ts`
- Modify: `apps/core/src/memory/assistant-conversation-context.ts`
- Modify: `apps/core/src/conversation/feishu-mention-answer-responder.ts`
- Modify: `apps/core/src/conversation-state/conversation-state-evidence-deletion.ts`
- Create: `apps/core/tests/shared-chat-source-verifier.test.ts`
- Extend: `apps/core/tests/assistant-source-lineage.test.ts`, answer-reply delivery/receipt/Postgres suites, `apps/core/tests/postgres-conversation-state-evidence-deletion.test.ts`

**Interfaces:**

```ts
export type SharedChatSourceVerifier = {
  verify(input:{chatId:string;sources:readonly SharedChatSourceBinding[]}):Promise<boolean>;
};
```

Consume Task 1 lock/hash helpers and pure verifier interface (the type above is the same contract, not a duplicate implementation). Add optional `chatSources` to receipt and optional `sharedChatSources` to prepare/delivery output; persist known empty arrays as new provenance version 1, preserve legacy missing marker. Propagate transitive `underlyingChatSources` through assistant fresh reads. Delivery service accepts optional `sharedChatVerifier`; any nonempty traces without verifier fail closed. Scope changes cannot silently update stored binding version. The remote edit test edits before the final probe: Feishu and Postgres do not share an atomic transaction.

- [ ] Step 1: RED tests for 9+ source verification, changed/deleted text, disabled source/destination, exact scope mismatch, bot denial, no verifier, revoked prepared answer and two-step rewrite. Test zero document sources can still block for shared-chat permission loss.

```ts
expect(await verifier.verify({chatId:"group-b",sources:nineSources})).toBe(true);
readerBodies.delete("old-questionnaire");
expect(await verifier.verify({chatId:"group-b",sources:nineSources})).toBe(false);
await service.respond(request);
expect(sentTexts).not.toContain("original protected answer");
```

- [ ] Step 2: Run focused verifier/delivery/assistant tests and retain RED output.
- [ ] Step 3: Implement chunked exact fresh read, hash/source/runtime/bot/tombstone verification; copy provenance into semantic fingerprint, receipt invariants and persistent rows. Recheck before send, then acquire Task 1 locks before delivery transition. Lock source messages in deletion and return conflict for associated in-flight deliveries. Reuse only verified sent Iris outputs, carrying original cross-chat source union. Legacy ambiguous contextual output is omitted when shared context enabled; no pretending old empty rows prove no dependency.
- [ ] Step 4: Run affected suites plus Postgres competing revoke/send/delete transactions. Assert revoke wins => no send; send_started wins => explicit mutation conflict. No network under transaction. Existing document-only receipts and idempotency still pass.
- [ ] Step 5: Self-review, typecheck and commit explicit files as `feat(core): bind shared chat answers to revocable provenance`.

### Task 4: Production wiring, exact scope API and four-layer closure

**Files:**
- Create: `apps/core/src/shared-chat/working-chat-scope-api.ts`
- Modify: `apps/core/src/runtime/answer-draft-runtime.ts`
- Modify: `apps/core/src/runtime/event-worker-runtime.ts`
- Modify: `apps/core/src/app.ts`
- Create: `apps/core/tests/working-chat-scope-api.test.ts`
- Extend: `apps/core/tests/answer-draft-runtime.test.ts`, `apps/core/tests/intent-before-retrieval.test.ts`
- Update: whitepaper, failure ledger, coverage baseline, README and `docs/development/current-handoff.md`
- Create: `docs/development/iris-shared-working-chat.md`

**Interfaces:**

Register protected GET/PUT `/internal/working-chat-scope`. PUT requires expectedVersion, state, groups, updatedBy; use existing internal bearer auth, reject malformed inputs with 400, CAS/inflight conflict409, unavailable503. Runtime creates one Postgres scope repository and verifier for provider/reuse/delivery; missing scope defaults closed. Controllers' local emergency off and durable runtime are both respected.

- [ ] Step 1: RED API tests for unauthenticated401, invalidbody400, exactCAS409, absent scope GET, successful roundtrip with explicit groups. RED integration test showing runtime (not a hand-built test-only provider) produces shared-chat evidence for ordinary source message without any Wiki write.

```ts
expect((await app.inject({method:"PUT",url:"/internal/working-chat-scope",payload:{}})).statusCode).toBe(401);
const draft=await runtime.orchestrator.generateDraft({question:"测试准备群的问卷重点是什么？",groupId:oldGroupId});
expect(draft.sharedChatSources?.some(s=>s.sourceChatId===testGroupId)).toBe(true);
```

- [ ] Step 2: Run focused API/runtime tests and verify RED.
- [ ] Step 3: Wire scope, verifier and delivery; ensure direct internal draft uses same source checks. Update four docs with implemented-but-not-deployed status and link precise evidence.
- [ ] Step 4: Run `npm run typecheck`, `npm run build`, `npm test`, available Postgres integration, `npm run test:python`, `npm run test:pilot`, `git diff --check`. Review changes against design; P0/P1 fixed, nonblocking followups recorded.
- [ ] Step 5: Commit explicit files. If production deployment/activation is performed under the current approved pilot scope, first record fresh SHA/health/exact group inventory and backup/rollback; preserve existing closed write/task/proactive flags, apply migrations then exact scope, validate real internal drafts with no Feishu test sends. If any gate fails keep scope revoked and current base Q&A. Record code/test/CI/deployment independently; never call code-only work deployed.

## Plan self-review

Task 1 produces shared types/tables/locks; Task 2 consumes them and adds prompt/result provenance; Task 3 persists and verifies that provenance; Task 4 wires the real runtime and API. Task 2 and Task 3 both touch assistant lineage tests: run sequentially or assign test additions to separate new files before parallel implementation. No task changes old document grant semantics. Historical source classification, revocation, global budgets, no-per-message approval and four-document closure each have a task and an acceptance check.
