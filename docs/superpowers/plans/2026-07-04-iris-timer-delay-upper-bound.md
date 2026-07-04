# Iris Timer Delay Upper Bound Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent timeout configurations above Node's safe timer delay from overflowing into very short request timeouts.

**Architecture:** Keep the bound in `apps/core/src/config/numeric-guards.ts`, because all current uses of `readPositiveSafeInteger()` are request timeout guards. Add a focused unit test for the boundary.

**Tech Stack:** TypeScript, Vitest, Node timers.

---

## File Structure

- Modify `apps/core/src/config/numeric-guards.ts`.
- Create `apps/core/tests/numeric-guards.test.ts`.

### Task 1: Regression Test

**Files:**
- Create: `apps/core/tests/numeric-guards.test.ts`

- [ ] **Step 1: Write failing boundary test**

```ts
import { describe, expect, it } from "vitest";

import { readPositiveSafeInteger } from "../src/config/numeric-guards.js";

describe("readPositiveSafeInteger", () => {
  it("rejects values above Node's maximum timer delay", () => {
    expect(readPositiveSafeInteger(2_147_483_647, "timeoutMs")).toBe(2_147_483_647);
    expect(() => readPositiveSafeInteger(2_147_483_648, "timeoutMs")).toThrow(
      "timeoutMs must not exceed 2147483647",
    );
  });
});
```

- [ ] **Step 2: Run RED**

Run: `npm --workspace apps/core test -- numeric-guards.test.ts`

Expected: FAIL because `2_147_483_648` is currently accepted.

### Task 2: Minimal Implementation

**Files:**
- Modify: `apps/core/src/config/numeric-guards.ts`

- [ ] **Step 1: Add max timer delay guard**

```ts
const MAX_TIMER_DELAY_MS = 2_147_483_647;

export function readPositiveSafeInteger(value: number, fieldName: string): number {
  if (!Number.isInteger(value) || value <= 0 || !Number.isSafeInteger(value)) {
    throw new Error(`${fieldName} must be a positive safe integer`);
  }
  if (value > MAX_TIMER_DELAY_MS) {
    throw new Error(`${fieldName} must not exceed ${MAX_TIMER_DELAY_MS}`);
  }

  return value;
}
```

- [ ] **Step 2: Run GREEN**

Run: `npm --workspace apps/core test -- numeric-guards.test.ts`

Expected: PASS.

### Task 3: Verification And PR

- [ ] **Step 1: Run full verification**

Run: `npm run verify`

Expected: PASS for diff check, typecheck, Core tests, Python tests, and Docker Compose config.

- [ ] **Step 2: Commit and push**

Run:

```powershell
git add apps/core/src/config/numeric-guards.ts apps/core/tests/numeric-guards.test.ts docs/superpowers/specs/2026-07-04-iris-timer-delay-upper-bound-design.md docs/superpowers/plans/2026-07-04-iris-timer-delay-upper-bound.md
git commit -m "fix: cap request timer delays"
git push
```

- [ ] **Step 3: Watch PR checks**

Run: `gh pr checks 3 --watch --interval 10`

Expected: Core and AI Worker checks pass.
