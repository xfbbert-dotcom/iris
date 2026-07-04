# Iris Root Verify Script Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this
> plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add one root command that runs Iris' local verification suite.

**Architecture:** Add `npm run verify` at the repository root and document it as the canonical full
local verification command. Keep individual scripts available for focused work.

**Tech Stack:** npm scripts, TypeScript, Vitest, Python pytest, Docker Compose, Markdown docs.

---

### Task 1: Failing Root Script Check

**Files:**
- Modify: `package.json`

- [x] **Step 1: Verify missing script**

Run:

```powershell
npm run verify
```

Expected: npm fails with `Missing script: "verify"`.

- [x] **Step 2: Add verify script**

Add:

```json
"verify": "git diff --check && npm run typecheck && npm test && npm run test:python && docker compose config"
```

### Task 2: Documentation Update

**Files:**
- Modify: `README.md`
- Modify: `docs/operations/internal-rollout-runbook.md`

- [x] **Step 1: Document canonical full verification**

Use:

```powershell
npm run verify
```

as the local full-suite command.

### Task 3: Verification

**Files:**
- Modify: `package.json`
- Modify: `README.md`
- Modify: `docs/operations/internal-rollout-runbook.md`

- [x] **Step 1: Run root verify**

Run:

```powershell
npm run verify
```

Expected: the script exits 0 after diff check, typecheck, Vitest, pytest, and Compose config.

- [ ] **Step 2: Commit, push, and verify PR checks**

Commit the script and docs, push `codex/iris-document-source-registry`, update PR #3, and confirm
GitHub Actions returns Core and AI Worker success.
