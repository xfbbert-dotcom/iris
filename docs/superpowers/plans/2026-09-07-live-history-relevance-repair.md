# Same-group live-history relevance repair implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Recover a recent rich post identified by a same-chat reply label even after short follow-up traffic displaces it from the latest twenty messages.

**Architecture:** Extend the existing Feishu history reader to at most two fifty-item pages. Select a bounded relevant message/reply-parent pair alongside the latest chronological context; reuse selection at the twenty-message context and ten-message planner boundaries.

**Tech Stack:** Existing TypeScript Core, Vitest, Feishu OpenAPI, Postgres tombstone reads; no dependency or schema migration.

**Spec:** `docs/superpowers/specs/2026-07-02-iris-answer-time-live-chat-context-design.md`, production correction.

## Global constraints

- Exact current chat only; no cross-group raw chat retrieval.
- Maximum 100 raw records, two HTTP history pages, 20 context messages, 10 planning messages.
- No history persistence, synthetic callback, publication, approval, or external message sending.
- Feishu denial or lookup error does not fall back to stale local rows.
- Exclude bot/deleted/unreadable messages and local tombstones; check runtime before and after I/O.
- Keep EmbeddingGemma query input at 512 UTF-8 bytes; stored document vectors unchanged.
- Non-blocking archive/quote traversal improvements remain backlog, not an unlimited release gate.

## Task 1: Bounded history pagination and reply metadata

Files: `apps/core/src/feishu/feishu-chat-history-reader.ts`, `apps/core/tests/feishu-chat-history-reader.test.ts`.

Interface: `listRecentMessages({ chatId: string, limit: number }): Promise<FeishuChatHistoryMessage[]>`;
message adds optional `parentMessageId?: string` and `rootMessageId?: string`.

- [ ] Add a failing two-page regression: fifty unrelated texts on page one; original post and its reply label on page two. Assert both returned for limit 100.

```ts
expect(messages.some(message => message.messageId === "original")).toBe(true);
expect(messages.find(message => message.messageId === "label")?.parentMessageId).toBe("original");
expect(fetch).toHaveBeenCalledTimes(2);
```

- [ ] Run `npm --workspace apps/core test -- feishu-chat-history-reader.test.ts`, observe RED.
- [ ] Follow only the validated page token, always on the same chat, sharing the operation timeout. Stop after two pages or enough valid messages. Reject missing/repeated cursors and malformed pages; retain sanitized errors and bounded response bodies.
- [ ] Repeat reader tests; verify limits 0 and 20 do not unnecessarily paginate, and raw scan never exceeds 100.

## Task 2: Relevant label and original content survive planning

Files: `apps/core/src/memory/live-chat-context-provider.ts`,
`apps/core/src/memory/context-assembly.ts`, `apps/core/src/agent/answer-draft-orchestrator.ts`,
`apps/core/src/runtime/answer-draft-runtime.ts`, a focused shared selector module, and their Vitest tests.

Interfaces: optional `question?: string` on `loadRecentMessages`; optional internal message/reply
IDs on `LiveChatMessage`. Selection consumes chronological messages, a question and an output limit;
it returns chronological messages without raising that limit.

- [ ] Add the actual failure-shaped regression: long original contains “访谈” but not “问卷”; a later
  “这是问卷” reply identifies it; fifty unrelated short messages follow. Use the real orchestrator
  and capture planner input, not just assembled prompt text.

```ts
expect(planningInputs[0]?.evidence.some(item => item.text.includes("每个人重点还原两三个具体片段"))).toBe(true);
expect(planningInputs[0]?.liveChatMessages.length).toBeLessThanOrEqual(10);
expect(result.promptContext).not.toContain("FOREIGN_GROUP_SOURCE");
```

- [ ] Run focused runtime/orchestrator tests and observe RED.
- [ ] Reuse existing lexical query terms with generic question terms removed. Select at most two
  relevant messages, including a matched label's parent/root only if that target is in the same
  authorized history response. Fill remaining slots from newest messages; emit chronological order.
- [ ] Apply selection before context cap 20 and planner cap 10; preserve internal IDs through
  normalization/dedupe without rendering them as source prose. Keep no-question behavior unchanged.
- [ ] Verify tombstones and scope before relevance; add ambiguous/no-match/no-question and disabled
  controls. Run full Core, Python, pilot, typecheck, build, readiness and Compose gates.

## Task 3: Reviewed exact-version rollout

- [ ] Update design/whitepaper/checklist/ledger with the two-page bound and reply-label behavior.
- [ ] Independent read-only review; resolve confirmed release blockers, record non-blocking findings.
- [ ] Commit and push; require exact-SHA CI including real database and Docker deployment checks.
- [ ] Follow `deploy/pilot/README.md` planned restart: durable disable, stop edge, empty queues,
  paired backup, matching images, disabled-state proof, explicit activation, internal acceptance,
  then public health and private-route boundary.
- [ ] Internal acceptance reads original Feishu content without injecting or persisting it. Assert
  it reaches actual planning evidence, answer is Chinese and grounded, other chat has no source,
  greeting still works, disabled group is rejected, OOM count and capability policy unchanged.

The user has already authorized autonomous implementation and scoped deployment. Continue in this
task; no additional human execution-choice handoff is required.
