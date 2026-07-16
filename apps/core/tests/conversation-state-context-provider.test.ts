import { describe, expect, it, vi } from "vitest";

import { createConversationStateContextProvider } from "../src/conversation-state/conversation-state-context-provider.js";

describe("createConversationStateContextProvider", () => {
  it("uses only current-group canonical threads and related actions within independent caps", async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({
        rows: Array.from({ length: 7 }, (_, index) => ({
          id: `thread-${index + 1}`,
          group_id: "group-a",
          status: index === 1 ? "resolved" : "open",
          summary: `launch plan ${index + 1}`,
          evidence_message_ids: [`thread-message-${index + 1}`],
        })),
      })
      .mockResolvedValueOnce({
        rows: Array.from({ length: 7 }, (_, index) => ({
          id: `action-${index + 1}`,
          group_id: "group-a",
          thread_id: index === 0 ? "thread-1" : null,
          description: `prepare launch ${index + 1}`,
          owner_ref: index === 1 ? "asker-1" : "owner-1",
          due_at: index === 0 ? new Date("2026-07-20T00:00:00.000Z") : null,
          status: "open",
          evidence_message_ids: [`action-message-${index + 1}`],
        })),
      });
    const provider = createConversationStateContextProvider({ dataSource: { query } });

    const result = await provider.loadRelevant({
      groupId: " group-a ",
      queryText: "Launch plan",
      askerId: " asker-1 ",
      limit: 999,
    });

    expect(result.threads.map((thread) => thread.id)).toEqual([
      "thread-1", "thread-2", "thread-3", "thread-4", "thread-5", "thread-6",
    ]);
    expect(result.actions.map((action) => action.id)).toEqual([
      "action-1", "action-2", "action-3", "action-4", "action-5", "action-6",
    ]);
    expect(result.threads[0]).toEqual({
      id: "thread-1",
      status: "open",
      summary: "launch plan 1",
      evidenceMessageIds: ["thread-message-1"],
    });
    expect(result.actions[0]).toEqual({
      id: "action-1",
      threadId: "thread-1",
      status: "open",
      description: "prepare launch 1",
      ownerRef: "owner-1",
      dueAt: new Date("2026-07-20T00:00:00.000Z"),
      evidenceMessageIds: ["action-message-1"],
    });

    const threadSql = query.mock.calls[0]?.[0] as string;
    const actionSql = query.mock.calls[1]?.[0] as string;
    expect(threadSql).toContain("status IN ('open', 'resolved')");
    expect(threadSql).toContain("merged_sources");
    expect(threadSql).toContain("canonical_thread_id");
    expect(threadSql).toContain("resolved");
    expect(threadSql).toContain("last_activity_at DESC");
    expect(actionSql).toContain("action.thread_id = ANY");
    expect(actionSql).toContain("LOWER(action.owner_ref)");
    expect(actionSql).toContain("LOWER(action.description)");
    expect(actionSql).toContain("thread.status IN ('candidate', 'merged')");
    expect(query).toHaveBeenNthCalledWith(1, expect.any(String), ["group-a", ["launch", "plan"], 6]);
    expect(query).toHaveBeenNthCalledWith(2, expect.any(String), [
      "group-a",
      ["launch", "plan"],
      ["thread-1", "thread-2", "thread-3", "thread-4", "thread-5", "thread-6"],
      "asker-1",
      6,
    ]);
  });

  it("rejects malformed rows rather than returning cross-group or candidate state", async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({
        rows: [{
          id: "candidate-thread",
          group_id: "other-group",
          status: "candidate",
          summary: "must not become prompt context",
          evidence_message_ids: [],
        }],
      })
      .mockResolvedValueOnce({ rows: [] });
    const provider = createConversationStateContextProvider({ dataSource: { query } });

    await expect(provider.loadRelevant({
      groupId: "group-a",
      queryText: "candidate",
      limit: 6,
    })).rejects.toThrow("conversation state thread is invalid");
  });
});
