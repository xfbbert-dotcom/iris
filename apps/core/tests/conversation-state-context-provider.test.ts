import { randomUUID } from "node:crypto";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { createConversationStateContextProvider } from "../src/conversation-state/conversation-state-context-provider.js";
import { defaultMigrationsDir, runMigrations } from "../src/database/migrate.js";

const databaseUrl = process.env.IRIS_TEST_DATABASE_URL?.trim();
const runIfDatabase = databaseUrl ? describe : describe.skip;

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
    expect(threadSql).toContain("merge_walk");
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

  it("normalizes bounded CJK n-grams and literal Latin terms before SQL ranking", async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });
    const provider = createConversationStateContextProvider({ dataSource: { query } });

    await provider.loadRelevant({
      groupId: "group-a",
      queryText: "请问发布新品会计划吗，THE Launch! plan_2026 100%",
      limit: 6,
    });

    expect(query).toHaveBeenNthCalledWith(1, expect.stringContaining("strpos"), [
      "group-a",
      ["发布", "布新", "新品", "品会", "会计", "计划", "launch", "plan_2026", "100%"],
      6,
    ]);
    expect(query.mock.calls[0]?.[0]).not.toContain("LIKE '%' || term || '%'");
    expect(query.mock.calls[1]?.[0]).toContain("strpos");
  });
});

runIfDatabase("ConversationStateContextProvider with Postgres", () => {
  let pool: pg.Pool | undefined;
  const suffix = randomUUID();
  const groupId = `context-provider-${suffix}`;
  const otherGroupId = `context-provider-other-${suffix}`;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: databaseUrl });
    const client = await pool.connect();
    try {
      await runMigrations({ client, migrationsDir: defaultMigrationsDir() });
    } finally {
      client.release();
    }
  });

  afterAll(async () => {
    await pool?.end();
  });

  it("uses literal multilingual terms, terminal merge chains, and deterministic current-group action routes", async () => {
    const ids = {
      terminal: `terminal-${suffix}`,
      middle: `middle-${suffix}`,
      source: `source-${suffix}`,
      cjkResolved: `cjk-resolved-${suffix}`,
      literalResolved: `literal-resolved-${suffix}`,
      stopResolved: `stop-resolved-${suffix}`,
      candidate: `candidate-${suffix}`,
      openA: `open-a-${suffix}`,
      openB: `open-b-${suffix}`,
      other: `other-${suffix}`,
      selectedAction: `selected-action-${suffix}`,
      ownerAction: `owner-action-${suffix}`,
      descriptionAction: `description-action-${suffix}`,
      unrelatedAction: `unrelated-action-${suffix}`,
      candidateAction: `candidate-action-${suffix}`,
    };
    await insertThread(pool!, { id: ids.terminal, groupId, status: "resolved", title: "Canonical", summary: "Terminal summary" });
    await insertThread(pool!, { id: ids.middle, groupId, status: "merged", title: "Middle", summary: "Middle summary", mergedIntoThreadId: ids.terminal });
    await insertThread(pool!, { id: ids.source, groupId, status: "merged", title: "Legacy 甲乙目标", summary: "Legacy summary", mergedIntoThreadId: ids.middle });
    await insertThread(pool!, { id: ids.cjkResolved, groupId, status: "resolved", title: "发布新品会计划", summary: "中文匹配" });
    await insertThread(pool!, { id: ids.literalResolved, groupId, status: "resolved", title: "Literal", summary: "plan_2026 is 100% complete" });
    await insertThread(pool!, { id: ids.stopResolved, groupId, status: "resolved", title: "the 什么", summary: "stopword-only text" });
    await insertThread(pool!, { id: ids.candidate, groupId, status: "candidate", title: "candidate needle", summary: "candidate only" });
    await insertThread(pool!, { id: ids.openA, groupId, status: "open", title: "Open A", summary: "tie", lastActivityAt: "2026-07-01T00:00:00.000Z" });
    await insertThread(pool!, { id: ids.openB, groupId, status: "open", title: "Open B", summary: "tie", lastActivityAt: "2026-07-01T00:00:00.000Z" });
    await insertThread(pool!, { id: ids.other, groupId: otherGroupId, status: "open", title: "甲乙 cross-group", summary: "must remain hidden" });
    await insertAction(pool!, { id: ids.selectedAction, groupId, threadId: ids.terminal, description: "selected route", ownerRef: "other" });
    await insertAction(pool!, { id: ids.ownerAction, groupId, description: "owner route", ownerRef: "ASKER-1" });
    await insertAction(pool!, { id: ids.descriptionAction, groupId, description: "publish release notes", ownerRef: "other" });
    await insertAction(pool!, { id: ids.unrelatedAction, groupId, description: "unrelated backlog", ownerRef: "other" });
    await insertAction(pool!, { id: ids.candidateAction, groupId, threadId: ids.candidate, description: "candidate action", ownerRef: "other" });
    const provider = createConversationStateContextProvider({ dataSource: pool! });

    const chain = await provider.loadRelevant({ groupId, queryText: "甲乙", askerId: "no-owner" });
    expect(chain.threads.map((thread) => thread.id)).toContain(ids.terminal);
    for (const hiddenThreadId of [ids.source, ids.middle, ids.candidate, ids.other]) {
      expect(chain.threads.map((thread) => thread.id)).not.toContain(hiddenThreadId);
    }
    expect(chain.actions.map((action) => action.id)).toContain(ids.selectedAction);
    expect(chain.actions.map((action) => action.id)).not.toContain(ids.candidateAction);

    const cjk = await provider.loadRelevant({ groupId, queryText: "发布会计划" });
    expect(cjk.threads.map((thread) => thread.id)).toContain(ids.cjkResolved);
    const stopwords = await provider.loadRelevant({ groupId, queryText: "THE 什么" });
    expect(stopwords.threads.map((thread) => thread.id)).not.toContain(ids.stopResolved);
    const literal = await provider.loadRelevant({ groupId, queryText: "plan_2026 100%" });
    expect(literal.threads.map((thread) => thread.id)).toContain(ids.literalResolved);
    const wildcard = await provider.loadRelevant({ groupId, queryText: "planX2026 100x" });
    expect(wildcard.threads.map((thread) => thread.id)).not.toContain(ids.literalResolved);

    const owner = await provider.loadRelevant({ groupId, queryText: "no-match", askerId: "asker-1" });
    expect(owner.actions.map((action) => action.id)).toContain(ids.ownerAction);
    expect(owner.actions.map((action) => action.id)).not.toContain(ids.unrelatedAction);
    const description = await provider.loadRelevant({ groupId, queryText: "release" });
    expect(description.actions.map((action) => action.id)).toContain(ids.descriptionAction);
    const ties = await provider.loadRelevant({ groupId, queryText: "no-match" });
    expect(ties.threads.slice(0, 2).map((thread) => thread.id)).toEqual([ids.openA, ids.openB].sort());
    for (const unresolvedMatchId of [
      ids.terminal,
      ids.cjkResolved,
      ids.literalResolved,
      ids.stopResolved,
    ]) {
      expect(ties.threads.map((thread) => thread.id)).not.toContain(unresolvedMatchId);
    }
  });

  it("fails closed for cycles, overdeep chains, and cross-group merge targets", async () => {
    const ids = {
      cycleA: `cycle-a-${suffix}`,
      cycleB: `cycle-b-${suffix}`,
      deepTerminal: `deep-terminal-${suffix}`,
      otherTerminal: `other-terminal-${suffix}`,
      crossSource: `cross-source-${suffix}`,
    };
    await insertThread(pool!, { id: ids.cycleA, groupId, status: "open", title: "cycle needle", summary: "cycle" });
    await insertThread(pool!, { id: ids.cycleB, groupId, status: "open", title: "cycle middle", summary: "cycle" });
    await pool!.query(
      "UPDATE discussion_threads SET status = 'merged', merged_into_thread_id = $2 WHERE id = $1",
      [ids.cycleA, ids.cycleB],
    );
    await pool!.query(
      "UPDATE discussion_threads SET status = 'merged', merged_into_thread_id = $2 WHERE id = $1",
      [ids.cycleB, ids.cycleA],
    );
    await insertThread(pool!, { id: ids.deepTerminal, groupId, status: "resolved", title: "deep terminal", summary: "terminal" });
    let nextId = ids.deepTerminal;
    for (let index = 0; index < 10; index += 1) {
      const id = `deep-${index}-${suffix}`;
      await insertThread(pool!, {
        id,
        groupId,
        status: "merged",
        title: index === 9 ? "overdeep needle" : `deep ${index}`,
        summary: "deep chain",
        mergedIntoThreadId: nextId,
      });
      nextId = id;
    }
    await insertThread(pool!, { id: ids.otherTerminal, groupId: otherGroupId, status: "open", title: "cross terminal", summary: "cross" });
    await insertThread(pool!, { id: ids.crossSource, groupId, status: "open", title: "cross needle", summary: "cross" });
    await pool!.query("SET session_replication_role = replica");
    try {
      await pool!.query(
        "UPDATE discussion_threads SET status = 'merged', merged_into_thread_id = $2 WHERE id = $1",
        [ids.crossSource, ids.otherTerminal],
      );
    } finally {
      await pool!.query("SET session_replication_role = origin");
    }
    const provider = createConversationStateContextProvider({ dataSource: pool! });

    const cycle = await provider.loadRelevant({ groupId, queryText: "cycle needle" });
    for (const hiddenThreadId of [ids.cycleA, ids.cycleB]) {
      expect(cycle.threads.map((thread) => thread.id)).not.toContain(hiddenThreadId);
    }
    const overdeep = await provider.loadRelevant({ groupId, queryText: "overdeep needle" });
    expect(overdeep.threads.map((thread) => thread.id)).not.toContain(ids.deepTerminal);
    const crossGroup = await provider.loadRelevant({ groupId, queryText: "cross needle" });
    for (const hiddenThreadId of [ids.crossSource, ids.otherTerminal]) {
      expect(crossGroup.threads.map((thread) => thread.id)).not.toContain(hiddenThreadId);
    }
  });
});

async function insertThread(
  pool: pg.Pool,
  input: {
    id: string;
    groupId: string;
    status: "candidate" | "open" | "resolved" | "merged";
    title: string;
    summary: string;
    mergedIntoThreadId?: string;
    lastActivityAt?: string;
  },
): Promise<void> {
  await pool.query(
    `
    INSERT INTO discussion_threads (
      id, group_id, title, summary, status, confidence, merged_into_thread_id,
      version, first_evidence_at, last_activity_at, resolved_at
    ) VALUES ($1, $2, $3, $4, $5, 0.9, $6, 1, NOW(), $7, $8)
    `,
    [
      input.id,
      input.groupId,
      input.title,
      input.summary,
      input.status,
      input.mergedIntoThreadId ?? null,
      input.lastActivityAt ?? "2026-07-02T00:00:00.000Z",
      input.status === "resolved" ? "2026-07-02T00:00:00.000Z" : null,
    ],
  );
}

async function insertAction(
  pool: pg.Pool,
  input: {
    id: string;
    groupId: string;
    threadId?: string;
    description: string;
    ownerRef: string;
  },
): Promise<void> {
  await pool.query(
    `
    INSERT INTO action_items (
      id, group_id, thread_id, description, owner_ref_type, owner_ref,
      status, confidence, version
    ) VALUES ($1, $2, $3, $4, 'text_label', $5, 'open', 0.9, 1)
    `,
    [input.id, input.groupId, input.threadId ?? null, input.description, input.ownerRef],
  );
}
