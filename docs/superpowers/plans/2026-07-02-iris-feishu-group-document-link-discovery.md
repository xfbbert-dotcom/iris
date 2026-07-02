# Iris Feishu Group Document Link Discovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Register supported Feishu/Lark document links found in group text messages as group-visible document sources with traceable group/message/user evidence.

**Architecture:** Extend group-visible document registration with optional `observedByUserId`, add a focused link extractor, add a registrar over the async document source registry, and invoke it from `FeishuMessageEventProcessor` after message fact upsert. The Feishu Gateway remains ack-first and does not parse links.

**Tech Stack:** TypeScript, Vitest, existing document source registry, existing raw event worker runtime.

---

## File Structure

- Modify `apps/core/src/documents/document-source-registry.ts`
  - Add optional `observedByUserId` to `RegisterGroupVisibleDocumentInput`.
  - Store it as group-message evidence `userId`.
- Modify `apps/core/src/documents/postgres-document-source-registry.ts`
  - Persist optional `observedByUserId` into `document_source_evidence.user_id`.
- Modify `apps/core/tests/document-source-registry.test.ts`
  - Cover user evidence for group-visible document registration.
- Modify `apps/core/tests/postgres-document-source-registry.test.ts`
  - Cover user evidence persistence.
- Create `apps/core/src/documents/feishu-document-link-extractor.ts`
  - Extract and normalize supported Feishu/Lark URLs from text.
- Create `apps/core/tests/feishu-document-link-extractor.test.ts`
  - Cover supported hosts, unsupported URLs, punctuation trimming, and dedupe.
- Create `apps/core/src/documents/group-visible-document-registrar.ts`
  - Register extracted links with chat/message/user evidence.
- Create `apps/core/tests/group-visible-document-registrar.test.ts`
  - Cover registration inputs and empty-link no-op.
- Modify `apps/core/src/conversation/feishu-message-event-processor.ts`
  - After message upsert, extract links and register them.
- Modify `apps/core/tests/feishu-message-event-processor.test.ts`
  - Cover registration for text links and skip behavior.
- Modify `apps/core/src/runtime/event-worker-runtime.ts`
  - Wire Postgres document source registry, extractor, and registrar into the processor.
- Modify `apps/core/tests/event-worker-runtime.test.ts`
  - Assert runtime composition includes the document registration dependencies.

## Task 1: Preserve Sender Evidence On Group-Visible Sources

**Files:**
- Modify: `apps/core/src/documents/document-source-registry.ts`
- Modify: `apps/core/src/documents/postgres-document-source-registry.ts`
- Modify: `apps/core/tests/document-source-registry.test.ts`
- Modify: `apps/core/tests/postgres-document-source-registry.test.ts`

- [ ] **Step 1: Write failing in-memory registry test**

Add a test that registers a group-visible document with `observedByUserId: "user-1"` and expects the first evidence item to include `userId: "user-1"`.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- document-source-registry.test.ts`

Expected: FAIL because `observedByUserId` is not accepted or not stored.

- [ ] **Step 3: Implement in-memory registry support**

Add `observedByUserId?: string` to `RegisterGroupVisibleDocumentInput`, normalize it, and write it to the group-message evidence `userId`.

- [ ] **Step 4: Run in-memory registry tests**

Run: `npm test -- document-source-registry.test.ts`

Expected: PASS.

- [ ] **Step 5: Write failing Postgres registry test**

Add a Postgres registry test that registers with `observedByUserId` and expects returned evidence `userId`.

- [ ] **Step 6: Run Postgres registry test to verify it fails**

Run: `npm test -- postgres-document-source-registry.test.ts`

Expected: FAIL because the Postgres registry does not persist user evidence yet.

- [ ] **Step 7: Implement Postgres registry support**

Use `input.observedByUserId`, normalize it, and write it to `next.evidence.userId`.

- [ ] **Step 8: Run registry tests**

Run: `npm test -- document-source-registry.test.ts postgres-document-source-registry.test.ts`

Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add apps/core/src/documents/document-source-registry.ts apps/core/src/documents/postgres-document-source-registry.ts apps/core/tests/document-source-registry.test.ts apps/core/tests/postgres-document-source-registry.test.ts
git commit -m "feat: preserve group document sender evidence"
```

## Task 2: Feishu Document Link Extractor

**Files:**
- Create: `apps/core/src/documents/feishu-document-link-extractor.ts`
- Test: `apps/core/tests/feishu-document-link-extractor.test.ts`

- [ ] **Step 1: Write failing extractor tests**

Tests should assert that supported Feishu/Lark URLs are extracted, unrelated URLs are ignored, trailing punctuation is trimmed, and repeated URLs are deduplicated.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- feishu-document-link-extractor.test.ts`

Expected: FAIL because the extractor file does not exist.

- [ ] **Step 3: Implement extractor**

Use a URL-like regex to collect `https://` URLs, parse each with `URL`, accept host `docs.feishu.cn`, any host ending `.feishu.cn`, and any host ending `.larksuite.com`, trim trailing chat punctuation, and dedupe normalized hrefs.

- [ ] **Step 4: Run extractor tests**

Run: `npm test -- feishu-document-link-extractor.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/core/src/documents/feishu-document-link-extractor.ts apps/core/tests/feishu-document-link-extractor.test.ts
git commit -m "feat: extract Feishu document links"
```

## Task 3: Group Visible Document Registrar

**Files:**
- Create: `apps/core/src/documents/group-visible-document-registrar.ts`
- Test: `apps/core/tests/group-visible-document-registrar.test.ts`

- [ ] **Step 1: Write failing registrar tests**

Tests should assert that links are registered with `sourceUri`, `originGroupId`, `originMessageId`, `observedByUserId`, and `observedAt`, and that empty link lists do nothing.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- group-visible-document-registrar.test.ts`

Expected: FAIL because the registrar file does not exist.

- [ ] **Step 3: Implement registrar**

Create `createGroupVisibleDocumentRegistrar({ registry })` with `registerDiscoveredLinks(input)`. Iterate links in order and await `registry.registerGroupVisibleDocument`.

- [ ] **Step 4: Run registrar tests**

Run: `npm test -- group-visible-document-registrar.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/core/src/documents/group-visible-document-registrar.ts apps/core/tests/group-visible-document-registrar.test.ts
git commit -m "feat: register group visible document links"
```

## Task 4: Feishu Message Processor Integration

**Files:**
- Modify: `apps/core/src/conversation/feishu-message-event-processor.ts`
- Modify: `apps/core/tests/feishu-message-event-processor.test.ts`

- [ ] **Step 1: Write failing processor tests**

Add tests that pass a text message containing a supported Feishu URL and expect `registerDiscoveredLinks` after `upsertMessage`; also verify image/non-text messages skip registration.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- feishu-message-event-processor.test.ts`

Expected: FAIL because the processor does not accept extractor/registrar dependencies yet.

- [ ] **Step 3: Implement processor integration**

Add optional dependencies `documentLinkExtractor` and `groupVisibleDocumentRegistrar`. After parsing and upserting a message, if `parsed.text` exists, extract links and register them with `chatId`, `messageId`, `senderId`, and `observedAt: parsed.sentAt`.

- [ ] **Step 4: Run processor tests**

Run: `npm test -- feishu-message-event-processor.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/core/src/conversation/feishu-message-event-processor.ts apps/core/tests/feishu-message-event-processor.test.ts
git commit -m "feat: discover group documents from Feishu messages"
```

## Task 5: Event Worker Runtime Wiring

**Files:**
- Modify: `apps/core/src/runtime/event-worker-runtime.ts`
- Modify: `apps/core/tests/event-worker-runtime.test.ts`

- [ ] **Step 1: Write failing runtime composition test**

Assert that the runtime creates a Postgres document source registry, creates a group-visible registrar with it, and passes extractor/registrar into `createProcessor`.

- [ ] **Step 2: Run runtime test to verify it fails**

Run: `npm test -- event-worker-runtime.test.ts`

Expected: FAIL because the runtime does not wire document discovery dependencies.

- [ ] **Step 3: Implement runtime wiring**

Create `documentSources = createPostgresDocumentSourceRegistry(pool)`, `documentLinkExtractor = createFeishuDocumentLinkExtractor()`, `groupVisibleDocumentRegistrar = createGroupVisibleDocumentRegistrar({ registry: documentSources })`, and pass both into the processor factory.

- [ ] **Step 4: Run runtime tests**

Run: `npm test -- event-worker-runtime.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/core/src/runtime/event-worker-runtime.ts apps/core/tests/event-worker-runtime.test.ts
git commit -m "feat: wire group document discovery runtime"
```

## Task 6: Full Verification And PR Update

**Files:**
- PR body only.

- [ ] **Step 1: Run TypeScript typecheck**

Run: `npm run typecheck`

Expected: exit 0.

- [ ] **Step 2: Run TypeScript tests**

Run: `npm test`

Expected: all tests pass.

- [ ] **Step 3: Run Python worker tests**

Run: `python -m pytest` from `workers/ai`

Expected: all tests pass.

- [ ] **Step 4: Run Docker Compose validation**

Run: `docker compose config`

Expected: exit 0.

- [ ] **Step 5: Push and update PR**

```bash
git push origin codex/iris-document-source-registry
gh pr edit 3 --repo xfbbert-dotcom/iris --body "<updated body with Phase 2W summary>"
```

Expected: PR #3 contains Phase 2W summary and checked test plan.

## Self-Review

- Spec coverage: link extraction, group-visible registration, sender evidence, async event worker integration, idempotency, and permission boundary are covered.
- Placeholder scan: no incomplete placeholder markers are present.
- Type consistency: `observedByUserId`, `registerDiscoveredLinks`, `extractLinks`, `chatId`, and `messageId` names are consistent across tasks.
