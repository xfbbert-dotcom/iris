# Iris Model Capacity User Degradation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give Feishu users one clear, deduplicated Chinese reply when the model provider returns HTTP 429 while preserving retries for every other model failure.

**Architecture:** Add a provider-independent typed HTTP error at the model boundary, throw it from the OpenAI-compatible adapter, and classify only status 429 in the existing Feishu mention responder. Keep the orchestrator, event queues, retry policy, and architecture whitepaper unchanged.

**Tech Stack:** TypeScript, Vitest, Node.js, Feishu message reply API, OpenAI-compatible model API.

## Global Constraints

- The architecture whitepaper remains authoritative and unchanged.
- Only `ModelProviderHttpError` status 429 receives the employee-facing fallback.
- The exact fallback text is `模型服务暂时达到使用上限，我现在无法可靠回答。恢复后，请再 @我一次。`
- Provider-controlled diagnostics and credentials must never appear in the fallback reply.
- Non-429 failures must continue to throw and retain the existing retry path.
- Follow red-green TDD for every behavior change.

---

### Task 1: Type model HTTP failures

**Files:**
- Create: `apps/core/src/model/model-provider-error.ts`
- Modify: `apps/core/src/model/openai-compatible-model-provider.ts`
- Modify: `apps/core/tests/openai-compatible-model-provider.test.ts`

**Interfaces:**
- Consumes: bounded model-provider HTTP status and the existing redacted external error message.
- Produces: `ModelProviderHttpError`, read-only `statusCode`, and `isModelProviderCapacityError(error)`.

- [ ] **Step 1: Write the failing typed-error test**

Import `ModelProviderHttpError`, invoke the provider with HTTP 429, and require the rejection to be an
instance with `statusCode === 429` and the existing bounded diagnostic message.

- [ ] **Step 2: Run the focused test and verify RED**

Run `npm test --workspace apps/core -- openai-compatible-model-provider.test.ts`.
Expected: module resolution or instance assertion fails because the typed error does not exist.

- [ ] **Step 3: Implement the minimal typed error boundary**

Create `ModelProviderHttpError extends Error`, set its stable name and read-only status, add a type
guard that matches only status 429, and replace the adapter's generic non-2xx error with this type.

- [ ] **Step 4: Run the focused test and verify GREEN**

Run the same command. Expected: all provider tests pass, including existing message and timeout
assertions.

### Task 2: Reply clearly when capacity is unavailable

**Files:**
- Modify: `apps/core/src/conversation/feishu-mention-answer-responder.ts`
- Modify: `apps/core/tests/feishu-mention-answer-responder.test.ts`

**Interfaces:**
- Consumes: `isModelProviderCapacityError(error)` from Task 1.
- Produces: one thread reply containing the exact model-capacity fallback, then a handled dedupe state.

- [ ] **Step 1: Write failing responder tests**

Require typed 429 to send the exact fallback and dedupe a callback retry. Require typed 503 and a
generic error mentioning 429 to reject without calling `replyText`.

- [ ] **Step 2: Run the focused test and verify RED**

Run `npm test --workspace apps/core -- feishu-mention-answer-responder.test.ts`.
Expected: the 429 case rejects because the responder recognizes only blank-answer errors.

- [ ] **Step 3: Implement the minimal capacity fallback**

Classify the caught error with the type guard, reply with the exact constant, and mark the message
handled only after the Feishu reply succeeds. Leave the outer release-and-rethrow behavior intact.

- [ ] **Step 4: Run the focused test and verify GREEN**

Run the same command. Expected: all responder tests pass.

### Task 3: Verify and publish the change

**Files:**
- Verify: all changed files and repository-wide checks.

**Interfaces:**
- Consumes: Tasks 1 and 2.
- Produces: reviewed, committed, and pushed PR #4 update without changing production activation state.

- [ ] **Step 1: Run focused and static verification**

Run `git diff --check`, Core typecheck, Core build, and the two focused Vitest files. Expected: clean
diff and all commands pass.

- [ ] **Step 2: Run the full repository verification**

Run the repository verification commands required by `package.json`, including Core, Python worker,
pilot operations, readiness, and Compose configuration. Expected: all pass.

- [ ] **Step 3: Request an independent code review**

Review the complete diff for incorrect classification, secret leakage, dedupe regressions, hidden
retries, and missing tests. Resolve every concrete finding with another red-green cycle.

- [ ] **Step 4: Commit and push**

Commit the implementation with `fix: explain model capacity limits in Feishu`, push the current
branch, and verify PR #4 checks. Do not start Caddy or enable Iris before the existing Gemini
recovery gate passes.
