# Iris Document Fragment Replacement Transaction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make document fragment replacement atomic on production Postgres queryables so failed
index writes cannot leave a partial semantic index.

**Architecture:** Keep `DocumentFragmentRepository`'s public API unchanged. Detect queryables that
also expose `connect()`, run replacement mutations through a transaction client, and fall back to the
existing direct `query()` path for simple test doubles.

**Tech Stack:** TypeScript, pg-style query clients, Vitest.

---

### Task 1: Write Failing Transaction Tests

**Files:**
- Modify: `apps/core/tests/document-fragment-repository.test.ts`

- [x] **Step 1: Add successful transaction coverage**

Add a test that passes a fake queryable with `connect()`. The fake client records `begin`, the
existing delete/insert/embedding queries, `commit`, and `release`. Expect
`replaceFragmentsForSnapshot` to resolve and expect direct `queryable.query` not to be used for
mutations.

- [x] **Step 2: Add rollback coverage**

Add a test where the fake transaction client throws `"embedding write failed"` on the embedding
insert. Expect `replaceFragmentsForSnapshot` to reject with that message, call `rollback`, skip
`commit`, and release the client.

- [x] **Step 3: Run focused tests and confirm RED**

Run:

```powershell
npm --workspace apps/core test -- document-fragment-repository.test.ts -t "transaction"
```

Expected: the new tests fail because `replaceFragmentsForSnapshot` still uses the direct queryable
and does not open a transaction.

Observed: both transaction tests failed because `replaceFragmentsForSnapshot` called the direct
queryable and never opened `connect()`.

### Task 2: Implement Transactional Replacement

**Files:**
- Modify: `apps/core/src/documents/document-fragment-repository.ts`

- [x] **Step 1: Add transaction-capable queryable types**

Add local types for a pg-style transaction client and a queryable with `connect()`.

- [x] **Step 2: Add helper**

Add `withTransactionIfSupported(queryable, operation)`:

```ts
if (!supportsTransactions(queryable)) {
  return operation(queryable);
}
const client = await queryable.connect();
try {
  await client.query("begin");
  const result = await operation(client);
  await client.query("commit");
  return result;
} catch (error) {
  try {
    await client.query("rollback");
  } catch {
    // Preserve the original mutation failure.
  }
  throw error;
} finally {
  client.release();
}
```

- [x] **Step 3: Move destructive mutations into the helper**

Keep profile lookup and validation before the helper. Inside the helper, perform the existing delete,
fragment insert, and embedding insert sequence against the transaction client.

- [x] **Step 4: Run focused tests and confirm GREEN**

Run:

```powershell
npm --workspace apps/core test -- document-fragment-repository.test.ts -t "transaction"
```

Expected: transaction tests pass.

Observed: transaction tests passed.

### Task 3: Verification and Publication

**Files:**
- Create: `docs/superpowers/specs/2026-07-05-iris-document-fragment-replacement-transaction-design.md`
- Create: `docs/superpowers/plans/2026-07-05-iris-document-fragment-replacement-transaction.md`

- [x] **Step 1: Run focused repository tests**

Run:

```powershell
npm --workspace apps/core test -- document-fragment-repository.test.ts
```

Expected: all document fragment repository tests pass.

Observed: `document-fragment-repository.test.ts` passed with 14 tests passed and 1 Postgres-gated
test skipped.

- [x] **Step 2: Run full verification**

Run:

```powershell
npm run verify
```

Expected: the command exits 0.

Observed: `npm run verify` exited 0 with Core 1002 passed / 4 skipped, Python 7 passed, and
`docker compose config` succeeded.

- [ ] **Step 3: Commit, push, and verify PR checks**

Commit the transaction hardening update, push `codex/iris-document-source-registry`, update PR #3,
and confirm GitHub Actions Core and AI Worker checks pass.
