# Iris Model Provider Resilience Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore reliable exact answers for the internal Iris pilot by moving the answer model to Gemini 3.6 Flash and adding one deadline-bounded retry for transient provider failures.

**Architecture:** Keep retrieval and permission enforcement unchanged. Make the OpenAI-compatible answer adapter responsible for request compatibility, exact-output prompt policy, and one narrowly classified retry within the existing total timeout; select Gemini 3.6 Flash only through production environment configuration.

**Tech Stack:** TypeScript, Vitest, OpenAI-compatible Gemini API, Docker Compose, GitHub Actions.

## Global Constraints

- Production remains fail-closed until bounded internal and Feishu acceptance gates pass.
- `IRIS_MODEL_TIMEOUT_MS` is one total deadline across all attempts and delay.
- Make at most two requests.
- Retry only HTTP 408/500/502/503/504 and transport `TypeError`.
- Never retry HTTP 429, permanent 4xx, aborts, malformed responses, or validation errors.
- Omit `temperature` from Gemini 3.6 requests.
- Do not add a fallback model or change retrieval and permission behavior.
- Do not merge the pull request.

---

### Task 1: Lock Request And Prompt Compatibility

**Files:**
- Modify: `apps/core/tests/openai-compatible-model-provider.test.ts`
- Modify: `apps/core/src/model/openai-compatible-model-provider.ts`

**Interfaces:**
- Consumes: `createOpenAICompatibleModelProvider()` and `ModelProvider.generateAnswerDraft()`.
- Produces: an OpenAI-compatible request without `temperature` and a system prompt with an exact-output rule.

- [ ] **Step 1: Change the request-body test**

Parse the outbound JSON body and assert:

```typescript
expect(body).not.toHaveProperty("temperature");
expect(body).toMatchObject({
  model: "model-a",
  messages: expect.any(Array),
});
```

- [ ] **Step 2: Add the exact-output policy test**

Generate a draft for `Please reply with exactly: IRIS_REAL_OK` and assert the
system message contains all of:

```typescript
"only or exactly one value"
"return only that value"
"no label, explanation, quotation marks, Markdown, or code fence"
```

- [ ] **Step 3: Run the focused tests and observe RED**

Run:

```powershell
npm --workspace apps/core test -- tests/openai-compatible-model-provider.test.ts
```

Expected: FAIL because the request still includes `temperature` and the exact
output policy is absent.

- [ ] **Step 4: Make the minimal prompt and request changes**

Remove the `temperature` property. Add one system-policy sentence matching the
three tested phrases while keeping the current safety and permission rules.

- [ ] **Step 5: Run the focused tests and observe GREEN**

Run the same command. Expected: PASS for request and prompt tests.

### Task 2: Lock The Retry Classification

**Files:**
- Modify: `apps/core/tests/openai-compatible-model-provider.test.ts`
- Modify: `apps/core/src/model/openai-compatible-model-provider.ts`

**Interfaces:**
- Consumes: dependency-injected `fetch`, `sleep`, `now`, and `random`.
- Produces: one retry for transient statuses or transport failures.

- [ ] **Step 1: Add a deterministic 503-then-success test**

Use a fetch implementation that returns a 503 once and a 200 response second.
Inject:

```typescript
sleep: vi.fn(async () => undefined),
random: () => 0,
```

Assert the answer succeeds, fetch is called twice, and sleep is called once
with `750`.

- [ ] **Step 2: Add retry exhaustion and non-retryable status tests**

Add independent tests asserting:

```typescript
// 503 twice
expect(fetch).toHaveBeenCalledTimes(2);
expect(sleep).toHaveBeenCalledTimes(1);
expect(error).toMatchObject({ statusCode: 503 });

// 429 and 401
expect(fetch).toHaveBeenCalledTimes(1);
expect(sleep).not.toHaveBeenCalled();
```

- [ ] **Step 3: Add transport and malformed-response tests**

Assert a first-attempt `TypeError` retries and succeeds. Assert a malformed 200
response fails after one request without sleeping.

- [ ] **Step 4: Run the focused tests and observe RED**

Run:

```powershell
npm --workspace apps/core test -- tests/openai-compatible-model-provider.test.ts
```

Expected: retry tests FAIL because the adapter currently makes one attempt.

- [ ] **Step 5: Extend the provider dependency contract**

Add optional dependencies:

```typescript
now?: () => number;
sleep?: (milliseconds: number) => Promise<void>;
random?: () => number;
```

Use `Date.now`, a Promise around `setTimeout`, and `Math.random` as production
defaults.

- [ ] **Step 6: Implement the two-attempt loop**

Use:

```typescript
const RETRYABLE_HTTP_STATUSES = new Set([408, 500, 502, 503, 504]);
const MAX_ATTEMPTS = 2;
const RETRY_BASE_DELAY_MS = 750;
const RETRY_JITTER_MS = 250;
```

Retry only when the caught value is a retryable `ModelProviderHttpError` or
`TypeError`, the first attempt has failed, and deadline budget remains.
Preserve the final error unchanged.

- [ ] **Step 7: Run the focused tests and observe GREEN**

Run the same focused test command. Expected: all provider tests PASS.

### Task 3: Enforce One Total Deadline

**Files:**
- Modify: `apps/core/tests/openai-compatible-model-provider.test.ts`
- Modify: `apps/core/src/model/openai-compatible-model-provider.ts`

**Interfaces:**
- Consumes: configured `timeoutMs` and injected monotonic test clock.
- Produces: per-attempt abort timers based on remaining total budget.

- [ ] **Step 1: Add a consumed-deadline regression**

Inject a clock sequence where the first request starts at `0`, returns 503, and
the next deadline check is at `5000` for a `5000` ms timeout. Assert:

```typescript
expect(fetch).toHaveBeenCalledTimes(1);
expect(sleep).not.toHaveBeenCalled();
expect(error).toMatchObject({ statusCode: 503 });
```

- [ ] **Step 2: Add a delay-budget regression**

Inject a clock where only 500 ms remains after a 503. Assert Iris does not
sleep for the 750 ms base delay and does not make a second request.

- [ ] **Step 3: Run the focused tests and observe RED**

Expected: tests FAIL because the adapter currently gives each request a fresh
full timeout.

- [ ] **Step 4: Implement remaining-budget timers**

Capture one deadline before attempt one:

```typescript
const deadlineAt = now() + timeoutMs;
```

Before sleeping and before each request, compute `deadlineAt - now()`. Start
the attempt's abort timer with only that remaining value. Skip retry when the
delay or another request cannot fit in the remaining budget.

- [ ] **Step 5: Run the provider suite and observe GREEN**

Run:

```powershell
npm --workspace apps/core test -- tests/openai-compatible-model-provider.test.ts
```

Expected: PASS with deterministic retry and deadline assertions.

### Task 4: Verify And Publish The Candidate

**Files:**
- Modify: `docs/operations/engineering-failure-ledger.md`
- Modify: the existing deployment log used by PR #17

**Interfaces:**
- Consumes: provider changes and the current PR #17 branch.
- Produces: a pushed candidate SHA with successful Core and AI Worker checks.

- [ ] **Step 1: Run focused and adjacent tests**

Run:

```powershell
npm --workspace apps/core test -- tests/openai-compatible-model-provider.test.ts tests/feishu-mention-answer-responder.test.ts tests/answer-draft-runtime.test.ts
```

Expected: PASS.

- [ ] **Step 2: Run Core verification**

Run:

```powershell
npm --workspace apps/core run typecheck
npm --workspace apps/core run build
```

Expected: both commands exit zero.

- [ ] **Step 3: Record the root cause and bounded repair**

Add a failure-ledger entry containing the confirmed 503 boundary, successful
3.6 probe, retry matrix, total-deadline rule, and the rule against expanding
this release blocker into unrelated hardening.

- [ ] **Step 4: Commit and push**

Commit only intended files, push `codex/iris-user-document-gray`, and verify
PR #17 Core and AI Worker checks reach success. Do not merge.

### Task 5: Deploy And Run Bounded Acceptance

**Files:**
- Modify: the existing deployment log used by PR #17
- Modify: `docs/operations/engineering-failure-ledger.md` only if acceptance exposes a reusable failure lesson

**Interfaces:**
- Consumes: successful PR checks, production runtime controls, and the existing authorized pilot document marker.
- Produces: production evidence for Gemini 3.6 exact answers while ending in a verified fail-closed state unless the full release gate is explicitly approved.

- [ ] **Step 1: Verify the fail-closed preflight**

Confirm global and desired global disabled, proactive speech disabled, all
known groups disabled, Caddy stopped, Core/Postgres/Redis/AI Worker healthy,
all event/document/reindex queues and DLQs empty, and no extraction worker
running. Stop on any mismatch and restore the baseline.

- [ ] **Step 2: Deploy matching candidate images**

Build and deploy Core and AI Worker from the same candidate SHA. Set
`IRIS_MODEL_NAME=gemini-3.6-flash` without changing embedding or extraction
models. Keep Caddy stopped and all runtime controls disabled.

- [ ] **Step 3: Run the internal exact-answer gate**

Invoke the internal answer path with the authorized pilot question that asks
for only `IRIS_USER_DOC_20260728_616559`. Require:

- exact answer text with no extra formatting;
- the expected fresh source is used;
- denied-source count is zero;
- live permission guard records allow;
- all queues and DLQs remain empty.

- [ ] **Step 4: Run one bounded Feishu pilot**

Only after the internal gate passes, create an automatic close timer, start
Caddy, enable global plus the pilot group, and leave every control/historical
group disabled. Send one exact-output question and verify the real Iris reply
contains only the expected marker.

- [ ] **Step 5: Restore and verify fail-closed**

Disable desired global and global, disable every known group, stop Caddy,
cancel the timer, and verify service health, queues, DLQs, image SHAs, and
candidate commit identity again.

- [ ] **Step 6: Record acceptance evidence**

Update the deployment log and PR #17 with exact automated, internal, and Feishu
results. State any remaining external action precisely. Do not merge.
