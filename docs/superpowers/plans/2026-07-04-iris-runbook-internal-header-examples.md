# Iris Runbook Internal Header Examples Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this
> plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make internal API examples in the rollout runbook copy-paste safe under token protection.

**Architecture:** Update the runbook so each `/internal/*` `Invoke-RestMethod` snippet includes
`-Headers $irisHeaders`, while `/health` remains unauthenticated.

**Tech Stack:** Markdown, PowerShell examples.

---

### Task 1: Update Internal API Examples

**Files:**
- Modify: `docs/operations/internal-rollout-runbook.md`

- [x] **Step 1: Update the security note**

State that internal examples below already include `-Headers $irisHeaders`.

- [x] **Step 2: Add headers to internal examples**

For every `/internal/*` `Invoke-RestMethod` snippet, include:

```powershell
-Headers $irisHeaders
```

- [x] **Step 3: Inspect examples**

Search for `Invoke-RestMethod`, `/internal`, and `irisHeaders` to confirm `/internal/*` examples
include the header while `/health` does not.

### Task 2: Verification

**Files:**
- Create: `docs/superpowers/specs/2026-07-04-iris-runbook-internal-header-examples-design.md`
- Create: `docs/superpowers/plans/2026-07-04-iris-runbook-internal-header-examples.md`

- [x] **Step 1: Run full verification**

Run:

```powershell
npm run verify
```

Expected: the command exits 0.

- [ ] **Step 2: Commit, push, and verify PR checks**

Commit the runbook update, push `codex/iris-document-source-registry`, update PR #3, and confirm
GitHub Actions returns Core and AI Worker success.
