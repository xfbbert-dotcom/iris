# Iris Answer Draft Live Chat Dedup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Avoid duplicated live chat messages in answer draft prompt context.

**Architecture:** Add a small pure helper inside `answer-draft-orchestrator.ts` that deduplicates combined live chat messages by exact `speaker` and `text`.

**Tech Stack:** TypeScript, Vitest, existing Iris core app.

---

### Task 1: Orchestrator Deduplication

**Files:**
- Modify: `apps/core/tests/answer-draft-orchestrator.test.ts`
- Modify: `apps/core/src/agent/answer-draft-orchestrator.ts`

- [x] **Step 1: Write failing orchestrator test**

Add a test where stored context and request context contain the same `{ speaker, text }` message, then assert `contextBuilder.buildContext` receives it only once.

- [x] **Step 2: Run test to verify it fails**

Run: `npm --workspace apps/core test -- tests/answer-draft-orchestrator.test.ts --reporter=dot`

Expected: FAIL because duplicate messages are still forwarded.

- [x] **Step 3: Implement deduplication**

Add a helper:

```ts
function dedupeLiveChatMessages(messages: LiveChatMessage[]): LiveChatMessage[] {
  const seen = new Set<string>();
  return messages.filter((message) => {
    const key = `${message.speaker}\u0000${message.text}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}
```

Use it after stored and request messages are combined.

- [x] **Step 4: Run orchestrator test to verify it passes**

Run: `npm --workspace apps/core test -- tests/answer-draft-orchestrator.test.ts --reporter=dot`

Expected: PASS.

### Task 2: Verification and Publishing

**Files:**
- Modify: `docs/superpowers/plans/2026-07-03-iris-answer-draft-live-chat-dedup.md`

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
git add apps/core/src/agent/answer-draft-orchestrator.ts apps/core/tests/answer-draft-orchestrator.test.ts docs/superpowers/specs/2026-07-03-iris-answer-draft-live-chat-dedup-design.md docs/superpowers/plans/2026-07-03-iris-answer-draft-live-chat-dedup.md
git commit -m "feat: dedupe answer draft live chat context"
git push --force-with-lease origin codex/iris-document-source-registry
```
