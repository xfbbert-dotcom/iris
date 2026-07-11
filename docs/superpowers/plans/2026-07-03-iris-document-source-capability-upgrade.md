# Iris Document Source Capability Upgrade Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Preserve knowledge-draft capability upgrades when a document source is later observed through a higher-trust registration path.

**Architecture:** Update duplicate-source merge behavior in `document-source-registry.ts` so `canUseForKnowledgeDrafts` is upgraded with logical OR while `canUseForAnswering` preserves the existing value during re-registration.

**Tech Stack:** TypeScript, Vitest, existing Iris core app.

---

### Task 1: Capability Merge Upgrade

**Files:**
- Modify: `apps/core/tests/document-source-registry.test.ts`
- Modify: `apps/core/src/documents/document-source-registry.ts`

- [x] **Step 1: Write failing registry test**

Add an assertion to the sourceType upgrade scenario that `canUseForKnowledgeDrafts` becomes `true` after admin authorization.

- [x] **Step 2: Run test to verify it fails**

Run: `npm --workspace apps/core test -- tests/document-source-registry.test.ts --reporter=dot`

Expected: FAIL because the merged source still has `canUseForKnowledgeDrafts: false`.

- [x] **Step 3: Implement merge upgrade**

In `registerSource`, set merged capability fields as:

```ts
canUseForAnswering: existing.canUseForAnswering,
canUseForKnowledgeDrafts:
  existing.canUseForKnowledgeDrafts || next.canUseForKnowledgeDrafts,
```

- [x] **Step 4: Run registry test to verify it passes**

Run: `npm --workspace apps/core test -- tests/document-source-registry.test.ts --reporter=dot`

Expected: PASS.

### Task 2: Verification and Publishing

**Files:**
- Modify: `docs/superpowers/plans/2026-07-03-iris-document-source-capability-upgrade.md`

- [x] **Step 1: Run full verification**

Run:

```bash
npm run typecheck
python -m pytest
docker compose config
npm test
```

Expected: all commands exit 0.

- [x] **Step 2: Mark checklist complete**

Update this plan so completed steps are checked.

- [x] **Step 3: Commit and push**

Run:

```bash
git add apps/core/src/documents/document-source-registry.ts apps/core/tests/document-source-registry.test.ts docs/superpowers/specs/2026-07-03-iris-document-source-capability-upgrade-design.md docs/superpowers/plans/2026-07-03-iris-document-source-capability-upgrade.md
git commit -m "feat: upgrade merged document source capabilities"
git push --force-with-lease origin codex/iris-document-source-registry
```
