# Iris Server Listen Security Boundaries Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Require both internal operator and Feishu callback authentication before direct Core startup listens beyond loopback.

**Architecture:** Extend the existing startup host resolver with the Feishu verification token. Keep request-level guards and `buildApp()` behavior unchanged; only the executable listener decision gains the second approved v1 security prerequisite.

**Tech Stack:** TypeScript, Fastify, Vitest

## Global Constraints

- Missing or blank `IRIS_INTERNAL_API_TOKEN` resolves to `127.0.0.1`.
- Missing or blank `FEISHU_VERIFICATION_TOKEN` resolves to `127.0.0.1`.
- Both required tokens resolve to `0.0.0.0`.
- `FEISHU_ENCRYPT_KEY` alone does not satisfy v1 non-loopback readiness.
- Malformed internal API tokens keep failing through the existing validator.
- `buildApp()`, `/health`, and request-level guards remain behaviorally unchanged.

---

### Task 1: Require both ingress credentials for non-loopback startup

**Files:**
- Modify: `apps/core/src/app.ts`
- Test: `apps/core/tests/answer-draft-api.test.ts`
- Modify: `docs/superpowers/specs/2026-06-30-iris-architecture-whitepaper.md`
- Modify: `docs/superpowers/specs/2026-07-10-iris-internal-api-loopback-fallback-design.md`
- Modify: `docs/operations/internal-rollout-runbook.md`

**Interfaces:**
- Produces: `resolveServerListenHost(internalApiToken: string | undefined, feishuVerificationToken: string | undefined): "127.0.0.1" | "0.0.0.0"`
- Consumes: `readFeishuAuthConfig().verificationToken` and the existing internal token validator

- [ ] **Step 1: Write the failing single-boundary tests**

Update the focused host-selection test to assert that internal-token-only and Feishu-token-only
configurations both resolve to `127.0.0.1`, while both values together resolve to `0.0.0.0`.

- [ ] **Step 2: Run the focused test and verify RED**

Run: `npm --workspace apps/core test -- tests/answer-draft-api.test.ts -t "selects a safe server listen host"`

Expected: FAIL because the current resolver permits `0.0.0.0` using only the internal token.

- [ ] **Step 3: Implement the second startup boundary**

Extend the resolver with the Feishu verification token, normalize blank values, and update the direct
entry point to pass `readFeishuAuthConfig().verificationToken`:

```ts
export function resolveServerListenHost(
  internalApiToken: string | undefined,
  feishuVerificationToken: string | undefined,
): "127.0.0.1" | "0.0.0.0" {
  const hasInternalApiToken = readInternalApiToken(internalApiToken) !== undefined;
  const hasFeishuVerificationToken = feishuVerificationToken?.trim() !== "" &&
    feishuVerificationToken !== undefined;
  return hasInternalApiToken && hasFeishuVerificationToken ? "0.0.0.0" : "127.0.0.1";
}
```

- [ ] **Step 4: Run focused and related tests and verify GREEN**

Run: `npm --workspace apps/core test -- tests/answer-draft-api.test.ts -t "internal API token guard|selects a safe server listen host"`

Expected: PASS.

- [ ] **Step 5: Run direct-start listener smoke tests**

Start Core once with only `IRIS_INTERNAL_API_TOKEN` and confirm the listener is `127.0.0.1`. Start it
again with both required tokens and confirm the listener is `0.0.0.0`, an unauthorized callback is
`401`, and a correctly tokened callback reaches the gateway.

- [ ] **Step 6: Run full repository verification**

Run: `npm run verify`

Expected: Type checking, Core tests, Python worker tests, and Compose validation pass.

- [ ] **Step 7: Commit the verified implementation**

```bash
git add apps/core/src/app.ts apps/core/tests/answer-draft-api.test.ts
git commit -m "fix: require feishu auth for network startup"
```
