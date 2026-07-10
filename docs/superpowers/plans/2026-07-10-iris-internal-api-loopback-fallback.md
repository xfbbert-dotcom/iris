# Iris Internal API Loopback Fallback Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **Superseded listener condition:** This plan records the first internal-token-only hardening step.
> The current non-loopback requirement is defined by
> `2026-07-10-iris-server-listen-security-boundaries.md` and requires both
> `IRIS_INTERNAL_API_TOKEN` and `FEISHU_VERIFICATION_TOKEN`.

**Goal:** Keep credential-free local Core startup on loopback while requiring a valid internal API token before the process listens on every host interface.

**Architecture:** Add one exported startup host resolver beside the existing token parser in `app.ts`. The direct executable entry point passes `IRIS_INTERNAL_API_TOKEN` through that resolver and uses the result in Fastify listen options; request-route behavior remains unchanged.

**Tech Stack:** TypeScript, Fastify, Vitest

## Global Constraints

- `buildApp()` keeps optional-token behavior for tests and embedded local use.
- Missing or blank `IRIS_INTERNAL_API_TOKEN` resolves to `127.0.0.1`.
- A valid token resolves to `0.0.0.0`.
- Existing invalid-token validation remains authoritative.
- `/health` and `/feishu/events` remain outside the internal bearer guard.

---

### Task 1: Protect the direct server listener

**Files:**
- Modify: `apps/core/src/app.ts`
- Test: `apps/core/tests/answer-draft-api.test.ts`
- Modify: `docs/superpowers/specs/2026-06-30-iris-architecture-whitepaper.md`
- Modify: `docs/operations/internal-rollout-runbook.md`

**Interfaces:**
- Produces: `resolveServerListenHost(internalApiToken: string | undefined): "127.0.0.1" | "0.0.0.0"`
- Consumes: existing `readInternalApiToken` token normalization and validation

- [ ] **Step 1: Write the failing host-selection test**

Add a focused test that expects missing and blank tokens to resolve to `127.0.0.1`, and a valid
token to resolve to `0.0.0.0`.

- [ ] **Step 2: Run the focused test and verify RED**

Run: `npm --workspace apps/core test -- tests/answer-draft-api.test.ts -t "selects a safe server listen host"`

Expected: FAIL because `resolveServerListenHost` is not exported yet.

- [ ] **Step 3: Implement the minimal resolver and wire the direct entry point**

Add the resolver using `readInternalApiToken`, then have the executable entry point pass the
configured token to both `buildApp` and Fastify `listen`:

```ts
export function resolveServerListenHost(
  internalApiToken: string | undefined,
): "127.0.0.1" | "0.0.0.0" {
  return readInternalApiToken(internalApiToken) === undefined ? "127.0.0.1" : "0.0.0.0";
}
```

- [ ] **Step 4: Run focused and related tests and verify GREEN**

Run: `npm --workspace apps/core test -- tests/answer-draft-api.test.ts -t "internal API token guard|selects a safe server listen host"`

Expected: PASS.

- [ ] **Step 5: Align constitutional and operator documentation**

Document that credential-free local startup binds only to loopback and that any deployment needing
non-loopback ingress must configure `IRIS_INTERNAL_API_TOKEN`.

- [ ] **Step 6: Run the full repository verification**

Run: `npm run verify`

Expected: TypeScript type checking, Core tests, Python worker tests, and `docker compose config` all
pass.

- [ ] **Step 7: Commit the verified change**

```bash
git add apps/core/src/app.ts apps/core/tests/answer-draft-api.test.ts docs/operations/internal-rollout-runbook.md docs/superpowers/specs/2026-06-30-iris-architecture-whitepaper.md docs/superpowers/specs/2026-07-10-iris-internal-api-loopback-fallback-design.md docs/superpowers/plans/2026-07-10-iris-internal-api-loopback-fallback.md
git commit -m "fix: keep unauthenticated core startup on loopback"
```
