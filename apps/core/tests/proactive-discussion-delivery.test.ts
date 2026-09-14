import { afterEach, describe, expect, test, vi } from "vitest";
import { createPdDeliveryWorker } from "../src/proactive-discussion/delivery-worker.js";
import { openPdDatabase, preparePdDelivery, pdTestAt as at, pdTestTime as time } from "./helpers/proactive-discussion-postgres.js";
import { pdContext, PILOT_CHAT } from "./fixtures/proactive-discussion.js";
import { createPdSourceVerifier } from "../src/proactive-discussion/source-verifier.js";
import type { FeishuMessageReplier } from "../src/feishu/feishu-message-replier.js";

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

describe.skipIf(!process.env.IRIS_TEST_DATABASE_URL)("proactive delivery worker with durable repository", () => {
  let db: Awaited<ReturnType<typeof openPdDatabase>>;
  afterEach(async () => { await db?.close(); });
  function history() {
    return pdContext().sources.map((source, index) => ({ messageId: source.kind === "message" ? source.binding.messageId : "invalid",
      chatId: PILOT_CHAT, senderId: "human", text: pdContext().items[index]!.text, sentAt: at }));
  }
  async function setup() {
    db = await openPdDatabase(); await preparePdDelivery(db, true);
    const live = history();
    const reader = { listRecentMessages: async () => live,
      readMessagesByIds: async ({ messageIds }: { messageIds: string[] }) => live.filter(message => messageIds.includes(message.messageId)) };
    const sourceVerifier = createPdSourceVerifier({ reader, documents: { verify: async () => [] }, canReadGroup: () => true, canProactivelySpeak: () => true });
    return { live, reader, sourceVerifier };
  }
  test.each(["timeout", "missing-receipt", "success", "receipt-write-failed", "all-receipt-writes-failed"])("%s never invokes the remote reply twice", async mode => {
    const deps = await setup();
    const replyText = vi.fn(async (_input: Parameters<FeishuMessageReplier["replyText"]>[0]) => {
      if (mode === "timeout") throw new Error("timeout after request");
      return mode === "missing-receipt" ? {} : { replyMessageId: "actual-receipt" };
    });
    const realFinish = db.repository.finishSend.bind(db.repository);
    if (mode.includes("write")) db.repository.finishSend = async input => {
      if (mode === "all-receipt-writes-failed" || input.outcome === "sent") throw new Error("database unavailable");
      return realFinish(input);
    };
    let current = at;
    const worker = createPdDeliveryWorker({ repository: db.repository, ...deps, replier: { replyText }, now: () => current, workerId: "worker" });
    await worker.runOnce();
    current = time(121);
    expect(await worker.runOnce()).toBe("idle");
    expect(replyText).toHaveBeenCalledTimes(1);
    expect(replyText.mock.calls[0]![0]).toMatchObject({ messageId: "m2", text: "两人需要 16 万，建议先核对预算。", replyInThread: false });
    expect(replyText.mock.calls[0]![0].uuid).toMatch(/^pd-[a-f0-9]{40}$/u);
    const row = (await db.pool.query("SELECT state,reply_message_id,reply_uuid FROM proactive_discussion_deliveries")).rows[0];
    expect(row.state).toBe(mode === "success" ? "sent" : "outcome_unknown");
    expect(row.reply_uuid).toBe(replyText.mock.calls[0]![0].uuid);
    expect(row.reply_message_id).toBe(mode === "success" ? "actual-receipt" : null);
  });
  test.each(["new-human", "edit", "deleted", "source-denied"])("%s during generation cancels old speech before any remote request", async change => {
    const deps = await setup();
    if (change === "new-human") deps.live.push({ ...deps.live[0]!, messageId: "m3", text: "我们已经追加预算" });
    if (change === "edit") deps.live[0]!.text = "预算已经增加";
    if (change === "deleted") deps.live.shift();
    if (change === "source-denied") deps.sourceVerifier.verify = async () => false;
    const replyText = vi.fn(async () => ({ replyMessageId: "should-not-send" }));
    const worker = createPdDeliveryWorker({ repository: db.repository, ...deps, replier: { replyText }, now: () => at, workerId: "worker" });
    expect(await worker.runOnce()).toBe("processed");
    expect(replyText).not.toHaveBeenCalled();
    expect((await db.pool.query("SELECT state FROM proactive_discussion_deliveries")).rows[0].state).toBe("cancelled");
  });
  test("old saved premise outside recent window remains valid when freshly readable by id", async () => {
    const deps = await setup();
    deps.reader.listRecentMessages = async () => [deps.live[1]!];
    const replyText = vi.fn(async () => ({ replyMessageId: "receipt" }));
    const worker = createPdDeliveryWorker({ repository: db.repository, ...deps, replier: { replyText }, now: () => at, workerId: "worker" });
    expect(await worker.runOnce()).toBe("processed");
    expect(replyText).toHaveBeenCalledTimes(1);
    expect((await db.pool.query("SELECT state FROM proactive_discussion_deliveries")).rows[0].state).toBe("sent");
  });
  test("document permission changed after remote verification never reaches the replier", async () => {
    db = await openPdDatabase(); await preparePdDelivery(db, false, "ordinary");
    const replyText = vi.fn(async () => ({ replyMessageId: "should-not-send" }));
    const worker = createPdDeliveryWorker({ repository: db.repository, reader: { listRecentMessages: async () => history() },
      sourceVerifier: { verify: async () => {
        await db.pool.query("UPDATE document_sources SET permission_state='stale' WHERE id='doc'");
        return true;
      } }, replier: { replyText }, now: () => at, workerId: "worker" });
    expect(await worker.runOnce()).toBe("processed");
    expect(replyText).not.toHaveBeenCalled();
    expect((await db.pool.query("SELECT state FROM proactive_discussion_deliveries")).rows[0].state).toBe("cancelled");
  });
  test("unrelated other-group and assistant messages do not become proactive human evidence", async () => {
    const deps = await setup();
    deps.reader.listRecentMessages = async () => [...deps.live, { ...deps.live[0]!, messageId: "outside", chatId: "other" },
      { ...deps.live[0]!, messageId: "bot", role: "assistant" as const }];
    const replyText = vi.fn(async () => ({ replyMessageId: "receipt" }));
    expect(await createPdDeliveryWorker({ repository: db.repository, ...deps, replier: { replyText }, now: () => at, workerId: "worker" }).runOnce()).toBe("processed");
    expect(replyText).toHaveBeenCalledTimes(1);
  });
  test("pending remote source verification holds no local locks", async () => {
    const deps = await setup();
    let release!: () => void; let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const pending = new Promise<void>(resolve => { release = resolve; });
    deps.sourceVerifier.verify = async () => { entered(); await pending; return true; };
    const replyText = vi.fn(async () => ({ replyMessageId: "should-not-send" }));
    const worker = createPdDeliveryWorker({ repository: db.repository, ...deps, replier: { replyText }, now: () => at, workerId: "worker" });
    const run = worker.runOnce(); await started;
    try { await db.pool.query("UPDATE runtime_control_state SET revision=revision+1"); }
    finally { release(); }
    expect(await run).toBe("processed");
    expect(replyText).not.toHaveBeenCalled();
  });
  test("remote verification and reply pending leave local transactions free to commit", async () => {
    const deps = await setup();
    let release!: () => void;
    let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const pending = new Promise<void>(resolve => { release = resolve; });
    const worker = createPdDeliveryWorker({ repository: db.repository, ...deps,
      replier: { replyText: async () => { entered(); await pending; return { replyMessageId: "receipt" }; } }, now: () => at, workerId: "worker" });
    const run = worker.runOnce(); await started;
    try {
      await db.pool.query("UPDATE runtime_control_state SET revision=revision+1");
      await db.pool.query("UPDATE conversation_messages SET text='稍后的变化' WHERE id='feishu:m2'");
    } finally { release(); }
    expect(await run).toBe("processed");
  });
});
