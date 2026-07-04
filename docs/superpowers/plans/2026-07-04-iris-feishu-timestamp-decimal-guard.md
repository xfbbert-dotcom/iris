# Iris Feishu Timestamp Decimal Guard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Treat malformed Feishu timestamp strings as invalid instead of coercing them into
arbitrary dates.

**Architecture:** Tighten `readFeishuTimestamp()` inside the Feishu message event processor so it
only accepts positive decimal millisecond strings within JavaScript's safe integer range. Invalid
message timestamps continue to fall back to the Feishu header timestamp, and invalid header
timestamps continue to fall back to `RawEvent.receivedAt`.

**Tech Stack:** TypeScript, Vitest, Markdown.

---

### Task 1: Strict Feishu Timestamp Parsing

**Files:**
- Modify: `apps/core/tests/feishu-message-event-processor.test.ts`
- Modify: `apps/core/src/conversation/feishu-message-event-processor.ts`

- [x] **Step 1: Write the failing non-decimal timestamp test**

Add a test where `event.message.create_time` is `"1e3"` and `header.create_time` is
`"1782925260000"`.

Expected before implementation: `sentAt` incorrectly becomes `1970-01-01T00:00:01.000Z`.

- [x] **Step 2: Run focused tests and confirm RED**

Run:

```powershell
npm test --workspace apps/core -- feishu-message-event-processor.test.ts
```

Expected: the new assertion fails because `Number("1e3")` is currently accepted.

- [x] **Step 3: Implement decimal millisecond parsing**

Update the timestamp parser to:

- trim string values;
- require `/^\d+$/u`;
- require `Number.isSafeInteger(parsed)` and `parsed > 0`;
- keep the existing invalid-date fallback.

- [x] **Step 4: Run focused tests and confirm GREEN**

Run:

```powershell
npm test --workspace apps/core -- feishu-message-event-processor.test.ts
```

Expected: the command exits 0.

### Task 2: Documentation And Verification

**Files:**
- Modify: `docs/superpowers/specs/2026-07-04-iris-feishu-header-timestamp-fallback-design.md`
- Create: `docs/superpowers/plans/2026-07-04-iris-feishu-timestamp-decimal-guard.md`

- [x] **Step 1: Document the strict timestamp rule**

Document that Feishu timestamps are accepted only as positive decimal millisecond strings.

- [x] **Step 2: Run full verification**

Run:

```powershell
npm run verify
```

Expected: the command exits 0.

- [ ] **Step 3: Commit, push, and verify PR checks**

Commit the timestamp guard update, push `codex/iris-document-source-registry`, update PR #3, and
confirm GitHub Actions returns Core and AI Worker success.
