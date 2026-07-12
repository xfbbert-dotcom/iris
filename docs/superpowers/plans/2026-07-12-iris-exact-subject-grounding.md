# Iris Exact-Subject Grounding Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent Iris from substituting a fact about a similarly named but different subject when the requested company fact is unavailable.

**Architecture:** Extend only the existing model system policy. Preserve retrieval, live permission filtering, context assembly, Feishu reply transport, and all public/internal API contracts.

**Tech Stack:** TypeScript, Vitest, npm workspaces, Docker Compose, Gemini through the existing OpenAI-compatible provider.

## Global Constraints

- The architecture whitepaper and permission-guard semantics remain unchanged.
- Denied document content and identifiers must never enter the model prompt.
- Iris stays globally disabled until automated and live regression gates pass.
- Follow red-green TDD and keep the change limited to the provider policy plus its tests.

---

### Task 1: Add the exact-subject grounding contract

**Files:**
- Modify: `apps/core/tests/openai-compatible-model-provider.test.ts`
- Modify: `apps/core/src/model/openai-compatible-model-provider.ts`

**Interfaces:**
- Consumes: `createOpenAICompatibleModelProvider()` and its existing captured chat-completions request.
- Produces: An unchanged `ModelProvider` API with a stricter system-message policy.

- [x] **Step 1: Write the failing provider test**

Add a test that captures the outbound request, reads the system message, and requires all three
policy clauses:

```ts
expect(systemPrompt).toContain("Match company facts to the exact subject and exact attribute");
expect(systemPrompt).toContain("Do not substitute a fact about a different");
expect(systemPrompt).toContain("state that the requested fact is unavailable");
```

- [x] **Step 2: Run the focused test and verify RED**

Run:

```bash
npm --workspace apps/core test -- openai-compatible-model-provider.test.ts
```

Expected: the new test fails because the current system prompt does not contain the exact-subject
grounding policy.

- [x] **Step 3: Add the minimal system-policy clause**

Add one sentence to `ANSWER_DRAFT_SYSTEM_PROMPT`:

```ts
"Match company facts to the exact subject and exact attribute named in the current Question. Do not substitute a fact about a different document, source type, project, person, date, or similarly named entity; when authorized evidence only supports a related but different subject, state that the requested fact is unavailable and do not return the related value.",
```

- [x] **Step 4: Run the focused test and verify GREEN**

Run the same focused command. Expected: all provider tests pass.

- [x] **Step 5: Commit the focused fix**

```bash
git add apps/core/tests/openai-compatible-model-provider.test.ts apps/core/src/model/openai-compatible-model-provider.ts docs/superpowers/specs/2026-07-12-iris-exact-subject-grounding-design.md docs/superpowers/plans/2026-07-12-iris-exact-subject-grounding.md
git commit -m "fix: prevent related-subject evidence substitution"
```

### Task 2: Verify and deploy with external replies disabled

**Files:**
- Verify only: repository test and deployment files.

**Interfaces:**
- Consumes: the commit-pinned pilot image and current rollback-safe deployment procedure.
- Produces: a disabled production runtime running the verified exact-subject policy.

- [x] **Step 1: Run full verification**

Run `npm run verify`. Expected: TypeScript, Core, Python worker, deployment tests, Compose config,
and readiness all pass.

- [x] **Step 2: Build and smoke the candidate image**

Build the exact commit SHA. With the revoked wiki source and allowed group-document source, call the
real answer-draft path and assert the answer contains neither `IRIS_WIKI_6158` nor
`IRIS_GROUP_DOC_4826`, while the revoked source remains in `deniedDocumentIds`.

Verified against the commit-pinned candidate image before the provider quota was exhausted: the
revoked wiki source remained in `deniedDocumentIds`, the allowed group document was the only related
evidence, and the generated answer returned neither marker.

- [x] **Step 3: Activate without reopening Feishu replies**

Stop public Caddy ingress, activate the commit-pinned Core image, set global runtime control to
disabled on the new process, verify it, then restore Caddy. Retain the previous image and rollback
source.

Activated `23efd782dd4857dafc2c19ade0cbf4e6c4248b88` with global runtime control disabled. The previous
`97273b46f3b673856bb687afad4728b8dca046ba` image and release remain available for rollback.

- [ ] **Step 4: Repeat the live gate**

Restore knowledge-base access and prove the authorized question returns `IRIS_WIKI_6158`. Revoke it
again and prove Iris does not return either marker. Restore access, re-sync, and only then re-enable
the global runtime.

Blocked on the external Gemini provider returning HTTP `429`. Keep Iris globally disabled and do
not repeat model probes aggressively. Resume this gate after quota or billing access recovers.

### Operational evidence collected while replies remain disabled

- Public health is reachable while public `/internal/*` remains hidden.
- Core, Redis, Postgres, Caddy, event worker, document-sync worker, and reindex worker are running;
  all worker queues and DLQs returned to zero.
- A controlled document-sync dead letter was listed through the operator API, atomically replayed,
  consumed by the worker, and cleared without enabling Feishu replies.
- The real Feishu global-disable smoke produced no Iris reply and no pending or dead-letter event.
