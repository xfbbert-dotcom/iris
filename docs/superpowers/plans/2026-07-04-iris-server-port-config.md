# Iris Server Port Config Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Validate the app listen port through the same env config boundary as the rest of Iris.

**Architecture:** Add `readServerPort()` to `apps/core/src/config/env.ts` and use it in the
executable branch of `apps/core/src/app.ts`.

**Tech Stack:** TypeScript, Vitest, Markdown.

---

### Task 1: Failing Port Config Coverage

**Files:**
- Modify: `apps/core/tests/env.test.ts`

- [x] **Step 1: Add failing server port tests**

Add tests for:

- default `PORT` -> `3000`;
- trimmed decimal `PORT`;
- rejected `PORT=0`;
- rejected `PORT=65536`;
- rejected `PORT=1e3`.

- [x] **Step 2: Run focused env tests and confirm RED**

Run:

```powershell
npm test --workspace apps/core -- env.test.ts
```

Expected: tests fail because `readServerPort()` does not exist yet.

### Task 2: Port Reader And Entrypoint Wiring

**Files:**
- Modify: `apps/core/src/config/env.ts`
- Modify: `apps/core/src/app.ts`
- Modify: `docs/superpowers/specs/2026-06-30-iris-architecture-whitepaper.md`
- Create: `docs/superpowers/specs/2026-07-04-iris-server-port-config-design.md`
- Create: `docs/superpowers/plans/2026-07-04-iris-server-port-config.md`

- [x] **Step 1: Implement `readServerPort()`**

Read `PORT` with the positive decimal integer helper, default to `3000`, and reject values above
`65535` with `PORT must be between 1 and 65535`.

- [x] **Step 2: Use `readServerPort()` in app entrypoint**

Replace the direct `Number(process.env.PORT ?? 3000)` listen call with the shared reader.

- [x] **Step 3: Run focused env tests and confirm GREEN**

Run:

```powershell
npm test --workspace apps/core -- env.test.ts
```

Expected: env tests pass.

- [x] **Step 4: Run full verification**

Run:

```powershell
npm run verify
```

Expected: the command exits 0.

- [ ] **Step 5: Commit, push, and verify PR checks**

Commit the server port config update, push `codex/iris-document-source-registry`, update PR #3,
and confirm GitHub Actions returns Core and AI Worker success.
