import { afterEach, describe, expect, test } from "vitest";
import { openPdDatabase } from "./helpers/proactive-discussion-postgres.js";
import { PILOT_CHAT, pdAssessment, pdContext, pdSkipAssessment } from "./fixtures/proactive-discussion.js";
import { hashLocalMessageText } from "../src/memory/local-message-source.js";
import { createPdSourceRef } from "../src/proactive-discussion/contracts.js";
import { createPostgresConversationMessageReplayGuard } from "../src/conversation/conversation-message-replay-guard.js";
import { createPdContextBuilder } from "../src/proactive-discussion/context-builder.js";
import { createPdSourceVerifier } from "../src/proactive-discussion/source-verifier.js";

const at = new Date("2026-09-14T00:00:00Z");
const time = (seconds: number) => new Date(at.getTime() + seconds * 1000);
type Database = Awaited<ReturnType<typeof openPdDatabase>>;

test("message bindings normalize only CRLF and source refs are canonical by binding", () => {
  expect(hashLocalMessageText("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  expect(hashLocalMessageText("a\r\nb")).toBe(hashLocalMessageText("a\nb"));
  expect(hashLocalMessageText(" a\nb")).not.toBe(hashLocalMessageText("a\nb"));
  const source = pdContext().sources[0]!;
  if (source.kind !== "message") throw new Error("expected message fixture");
  expect(createPdSourceRef({ kind: "message", binding: {
    contentHash: source.binding.contentHash, messageId: "m1", chatId: PILOT_CHAT,
  } })).toBe(source.ref);
  expect(createPdSourceRef({ kind: "message", binding: { ...source.binding, contentHash: "a".repeat(64) } })).not.toBe(source.ref);
  const document = { kind: "document" as const, binding: { documentSourceId: "doc", documentSnapshotId: "snapshot",
    crossGroupGrantId: "grant", crossGroupGrantVersion: 1, crossGroupGrantorGroupId: "owner", crossGroupGranteeGroupId: PILOT_CHAT } };
  expect(createPdSourceRef(document)).not.toBe(createPdSourceRef({ ...document, binding: { ...document.binding, crossGroupGrantVersion: 2 } }));
});

describe.skipIf(!process.env.IRIS_TEST_DATABASE_URL)("proactive discussion PostgreSQL foundation", () => {
  let db: Database | undefined;
  afterEach(async () => { await db?.close(); db = undefined; });
  async function open() { db = await openPdDatabase(); return db; }
  async function enabled() {
    const value = await open();
    await value.repository.setPolicy({ policy: { chatId: PILOT_CHAT, version: 1, enabled: true, operatorId: "test-operator" }, expectedVersion: 0, at });
    return value;
  }
  async function message(value: Database, id = "m1", text = "预算只有 10 万", chat = PILOT_CHAT) {
    await value.pool.query(`INSERT INTO conversation_messages
      (id,provider,provider_message_id,chat_id,message_type,text,sender_open_id,sent_at,raw_event_idempotency_key)
      VALUES ($1,'feishu',$2,$3,'text',$4,'test-human',$5,$2)`, [`feishu:${id}`, id, chat, text, at]);
  }
  const registration = (id = "m1", text = "预算只有 10 万") => ({
    chatId: PILOT_CHAT, messageId: id, contentHash: hashLocalMessageText(text), policyVersion: 1, purpose: "assessment" as const, at,
  });

  test("concurrent synonymous new issues from one catalog prepare once and stale the other job", async () => {
    const value = await enabled();
    await value.pool.query(`UPDATE runtime_control_state SET desired_global_enabled=true,
      capabilities=jsonb_set(jsonb_set(capabilities,'{readGroupContext}','true'),'{proactiveSpeech}','true')`);
    await message(value);
    await message(value, "m2", "按每人 8 万招两人，预算够");
    await value.repository.register(registration());
    await value.repository.register(registration("m2", "按每人 8 万招两人，预算够"));
    const jobA = await value.repository.claimEvaluation({ workerId: "a", at, leaseUntil: time(10) });
    const jobB = await value.repository.claimEvaluation({ workerId: "b", at, leaseUntil: time(10) });
    const state = await value.repository.readState(PILOT_CHAT);
    const context = { ...pdContext(), contextVersion: state.contextVersion, catalogVersion: state.catalogVersion };
    const assessment = pdAssessment();
    const results = await Promise.all([
      value.repository.commitEvaluation({ job: jobA!, context: { ...context, triggerMessageId: jobA!.messageId }, assessment,
        draft: { text: "两人共需 16 万，超出 10 万预算。建议先调整人数或预算。", evidenceRefs: assessment.evidenceRefs }, at }),
      value.repository.commitEvaluation({ job: jobB!, context: { ...context, triggerMessageId: jobB!.messageId }, assessment,
        draft: { text: "目前预算不够两人，请先核对。", evidenceRefs: assessment.evidenceRefs }, at }),
    ]);
    expect(results.sort()).toEqual(["prepared", "stale"]);
    expect((await value.repository.readState(PILOT_CHAT)).issues).toHaveLength(1);
    expect((await value.pool.query("SELECT * FROM proactive_discussion_deliveries")).rows).toHaveLength(1);
    expect((await value.pool.query("SELECT * FROM proactive_discussion_jobs")).rows).toHaveLength(2);
  });

  async function evaluationSetup() {
    const value = await enabled();
    await value.pool.query("UPDATE runtime_control_state SET desired_global_enabled=true");
    await message(value);
    await message(value, "m2", "按每人 8 万招两人，预算够");
    return value;
  }
  async function evaluation(value: Database, id = "m2", text = "按每人 8 万招两人，预算够", policyVersion = 1) {
    await value.repository.register({ ...registration(id, text), policyVersion });
    const job = await value.repository.claimEvaluation({ workerId: "evaluator", at, leaseUntil: time(30) });
    const state = await value.repository.readState(PILOT_CHAT);
    return { job: job!, context: { ...pdContext(), triggerMessageId: id, ...state, policy: state.policy! } };
  }
  const advice = (assessment = pdAssessment()) => ({ text: "请先核对招聘预算与人数。", evidenceRefs: assessment.evidenceRefs });

  test("distinct issues can prepare consecutively and every exposed source and policy authorization is durable", async () => {
    const value = await evaluationSetup();
    const first = await evaluation(value);
    expect(await value.repository.commitEvaluation({ ...first, assessment: pdAssessment(), draft: advice(), at })).toBe("prepared");
    const second = await evaluation(value, "m1", "预算只有 10 万");
    const assessment = { ...pdAssessment(), issueRef: { kind: "new" as const, description: "成本计划缺少保险支出" } };
    expect(await value.repository.commitEvaluation({ ...second, assessment, draft: advice(assessment), at })).toBe("prepared");
    expect((await value.repository.readState(PILOT_CHAT)).issues).toHaveLength(2);
    const deliveries = (await value.pool.query("SELECT * FROM proactive_discussion_deliveries")).rows;
    expect(deliveries).toHaveLength(2);
    expect(deliveries.every(row => row.authorization_kind === "policy" && row.state === "prepared")).toBe(true);
    expect((await value.pool.query("SELECT * FROM proactive_discussion_sources WHERE evaluation_id IS NOT NULL")).rows).toHaveLength(4);
    expect((await value.pool.query("SELECT * FROM proactive_discussion_sources WHERE delivery_id IS NOT NULL")).rows).toHaveLength(4);
    expect((await value.pool.query("SELECT * FROM proactive_discussion_events WHERE entity_type='delivery' AND payload->>'authorization_kind'='policy'")).rows).toHaveLength(2);
  });

  test.each(["duplicate", "already_handled", "no_work_value"] as const)("%s records silence without new basis or delivery", async reason => {
    const value = await evaluationSetup();
    const first = await evaluation(value);
    await value.repository.commitEvaluation({ ...first, assessment: pdAssessment(), draft: advice(), at });
    const next = await evaluation(value, "m1", "预算只有 10 万");
    const before = next.context.issues[0]!;
    expect(await value.repository.commitEvaluation({ ...next,
      assessment: { ...pdSkipAssessment(reason), issueRef: { kind: "existing", id: before.id } }, draft: null, at })).toBe("skipped");
    expect((await value.repository.readState(PILOT_CHAT)).issues[0]).toEqual(before);
    expect((await value.pool.query("SELECT * FROM proactive_discussion_deliveries")).rows).toHaveLength(1);
    expect((await value.pool.query("SELECT outcome FROM proactive_discussion_evaluations ORDER BY created_at,id")).rows.map(r => r.outcome).sort()).toEqual(["prepared", "skipped"]);
  });

  test("policy restart and rewritten explanation on unchanged bindings cannot advance a basis", async () => {
    const value = await evaluationSetup();
    const first = await evaluation(value);
    await value.repository.commitEvaluation({ ...first, assessment: pdAssessment(), draft: advice(), at });
    await value.repository.setPolicy({ policy: { ...first.context.policy, version: 2 }, expectedVersion: 1, at });
    const next = await evaluation(value, "m2", "按每人 8 万招两人，预算够", 2);
    const assessment = { ...pdAssessment(), issueRef: { kind: "existing" as const, id: next.context.issues[0]!.id },
      materialChange: { kind: "new_evidence" as const, explanation: "换句话说总数仍然不够", evidenceRefs: pdAssessment().evidenceRefs } };
    expect(await value.repository.commitEvaluation({ ...next, assessment, draft: advice(assessment), at })).toBe("blocked");
    expect((await value.repository.readState(PILOT_CHAT)).issues[0]!.basisVersion).toBe(1);
    expect((await value.pool.query("SELECT * FROM proactive_discussion_deliveries")).rows).toHaveLength(1);
  });

  test.each([false, true])("consumed issue evidence stays consumed across later bases, resolution cycle=%s", async resolve => {
    const value = await evaluationSetup();
    await message(value, "c", "增加 20 万强制设备成本");
    const binding = { chatId: PILOT_CHAT, messageId: "c", contentHash: hashLocalMessageText("增加 20 万强制设备成本") };
    const source = { kind: "message" as const, binding, ref: createPdSourceRef({ kind: "message", binding }) };
    const first = await evaluation(value);
    // Exposed context is not itself consumed issue evidence: C is uncited here.
    first.context.sources.push(source);
    first.context.items.push({ ref: source.ref, text: "增加 20 万强制设备成本" });
    expect(await value.repository.commitEvaluation({ ...first, assessment: pdAssessment(), draft: advice(), at })).toBe("prepared");
    const issueId = (await value.repository.readState(PILOT_CHAT)).issues[0]!.id;
    if (resolve) {
      const resolution = await evaluation(value, "m1", "预算只有 10 万");
      resolution.context.sources.push(source);
      expect(await value.repository.commitEvaluation({ ...resolution, assessment: { ...pdSkipAssessment("resolved"),
        issueRef: { kind: "existing", id: issueId } }, draft: null, at })).toBe("skipped");
    }
    const next = await evaluation(value, "c", "增加 20 万强制设备成本");
    next.context.sources.push(source);
    next.context.items.push({ ref: source.ref, text: "增加 20 万强制设备成本" });
    const changed = { ...pdAssessment(), issueRef: { kind: "existing" as const, id: issueId }, evidenceRefs: [source.ref],
      materialChange: { kind: "new_evidence" as const, explanation: "强制设备成本扩大预算缺口", evidenceRefs: [source.ref] } };
    expect(await value.repository.commitEvaluation({ ...next, assessment: changed, draft: advice(changed), at })).toBe("prepared");
    const before = (await value.repository.readState(PILOT_CHAT)).issues[0]!;
    expect(before.basisVersion).toBe(2);
    expect(before.basisSources).toEqual([source]);
    await message(value, "repeat", "再看看原来的预算");
    const old = await evaluation(value, "repeat", "再看看原来的预算");
    old.context.sources.push(source);
    const originalRef = pdContext().sources[0]!.ref;
    const repeated = { ...changed, evidenceRefs: [originalRef],
      materialChange: { kind: "new_evidence" as const, explanation: "换个说法再次强调原来预算不足", evidenceRefs: [originalRef] } };
    expect(await value.repository.commitEvaluation({ ...old, assessment: repeated, draft: advice(repeated), at })).toBe("blocked");
    expect((await value.pool.query("SELECT last_error FROM proactive_discussion_jobs WHERE id=$1", [old.job.id])).rows[0].last_error)
      .toBe("issue_evidence_already_consumed");
    expect((await value.repository.readState(PILOT_CHAT)).issues[0]).toEqual(before);
    expect((await value.pool.query("SELECT * FROM proactive_discussion_deliveries WHERE issue_id=$1", [issueId])).rows).toHaveLength(2);
  });

  test("fresh verified history-only context prepares without inventing local message facts", async () => {
    const value = await enabled();
    await value.pool.query("UPDATE runtime_control_state SET desired_global_enabled=true");
    await message(value, "m2", "按每人 8 万招两人，预算够");
    const { job } = await evaluation(value);
    const history = pdContext().sources.map((source, index) => ({
      messageId: source.kind === "message" ? source.binding.messageId : "invalid",
      chatId: PILOT_CHAT, senderId: "test-human", text: pdContext().items[index]!.text, sentAt: at,
    }));
    const reader = { listRecentMessages: async () => history,
      readMessagesByIds: async ({ messageIds }: { messageIds: string[] }) => history.filter(item => messageIds.includes(item.messageId)) };
    const builder = createPdContextBuilder({ repository: value.repository, reader, canReadGroup: () => true,
      documents: () => ({ buildContext: async () => ({ promptContext: "", allowedFragments: [], deniedDocumentIds: [],
        retrievedFragmentCount: 0, usedGroupMemories: [] }) }),
      sourceVerifier: createPdSourceVerifier({ reader, documents: { verify: async () => [] },
        canReadGroup: () => true, canProactivelySpeak: () => true }) });
    const context = await builder.load(job);
    expect(context?.sources).toEqual(pdContext().sources);
    expect(await value.repository.commitEvaluation({ job, context: context!, assessment: pdAssessment(), draft: advice(), at })).toBe("prepared");
    expect((await value.pool.query("SELECT provider_message_id FROM conversation_messages ORDER BY provider_message_id")).rows).toEqual([{ provider_message_id: "m2" }]);
    expect((await value.pool.query("SELECT * FROM proactive_discussion_sources WHERE delivery_id IS NOT NULL")).rows).toHaveLength(2);
  });

  test.each(["deleted", "tombstoned", "moved", "changed"])("nontrigger source %s requeues the same valid trigger against fresh context", async change => {
    const value = await evaluationSetup();
    const first = await evaluation(value);
    if (change === "deleted") await value.pool.query("DELETE FROM conversation_messages WHERE provider_message_id='m1'");
    if (change === "changed") await value.pool.query("UPDATE conversation_messages SET text='预算已调整' WHERE provider_message_id='m1'");
    if (change === "moved") await value.pool.query("UPDATE conversation_messages SET chat_id='other' WHERE provider_message_id='m1'");
    if (change === "tombstoned") {
      await value.pool.query(`INSERT INTO conversation_message_deletion_tombstones
        (provider,provider_message_id,conversation_message_id,chat_id) VALUES('feishu','m1','feishu:m1',$1)`, [PILOT_CHAT]);
      // Tombstones must independently protect source IDs, even if a new builder
      // snapshot has observed the group version while remote history lags deletion.
      first.context.contextVersion = (await value.repository.readState(PILOT_CHAT)).contextVersion;
    }
    expect(await value.repository.commitEvaluation({ ...first, assessment: pdAssessment(), draft: advice(), at })).toBe("stale");
    const saved = (await value.pool.query("SELECT state,attempts,last_error FROM proactive_discussion_jobs WHERE id=$1", [first.job.id])).rows[0];
    expect(saved).toMatchObject({ state: "pending", attempts: 0 });
    expect(saved.last_error).toContain("context_stale");
    const retry = (await value.repository.claimEvaluation({ workerId: "fresh", at: time(1), leaseUntil: time(30) }))!;
    expect(retry.id).toBe(first.job.id);
    const state = await value.repository.readState(PILOT_CHAT);
    const context = { ...first.context, ...state, policy: state.policy!,
      sources: [pdContext().sources[1]!], items: [pdContext().items[1]!] };
    expect(await value.repository.commitEvaluation({ job: retry, context, assessment: pdSkipAssessment("already_handled"), draft: null, at: time(1) })).toBe("skipped");
    expect((await value.pool.query("SELECT * FROM proactive_discussion_jobs")).rows).toHaveLength(1);
    expect((await value.pool.query("SELECT * FROM proactive_discussion_deliveries")).rows).toHaveLength(0);
  });

  test("resolved skip cancels pending drafts and only materially new premises can reopen", async () => {
    const value = await evaluationSetup();
    const first = await evaluation(value);
    await value.repository.commitEvaluation({ ...first, assessment: pdAssessment(), draft: advice(), at });
    const resolution = await evaluation(value, "m1", "预算只有 10 万");
    const issueId = resolution.context.issues[0]!.id;
    expect(await value.repository.commitEvaluation({ ...resolution,
      assessment: { ...pdSkipAssessment("resolved"), issueRef: { kind: "existing", id: issueId } }, draft: null, at })).toBe("skipped");
    expect((await value.repository.readState(PILOT_CHAT)).issues[0]).toMatchObject({ state: "resolved", basisVersion: 1, version: 2 });
    expect((await value.pool.query("SELECT state FROM proactive_discussion_deliveries")).rows[0].state).toBe("cancelled");
    await message(value, "m3", "新增强制设备成本 20 万");
    const next = await evaluation(value, "m3", "新增强制设备成本 20 万");
    const binding = { chatId: PILOT_CHAT, messageId: "m3", contentHash: hashLocalMessageText("新增强制设备成本 20 万") };
    const source = { kind: "message" as const, ref: createPdSourceRef({ kind: "message", binding }), binding };
    next.context.sources.push(source);
    next.context.items.push({ ref: source.ref, text: "新增强制设备成本 20 万" });
    const assessment = { ...pdAssessment(), issueRef: { kind: "existing" as const, id: issueId }, evidenceRefs: [source.ref],
      materialChange: { kind: "new_evidence" as const, explanation: "新增强制成本使已解决的预算再次不足", evidenceRefs: [source.ref] } };
    expect(await value.repository.commitEvaluation({ ...next, assessment, draft: advice(assessment), at })).toBe("prepared");
    expect((await value.repository.readState(PILOT_CHAT)).issues[0]).toMatchObject({ state: "observing", basisVersion: 2, version: 3 });
  });

  test("incomplete hidden catalog blocks new admission with an auditable reason", async () => {
    const value = await evaluationSetup();
    const first = await evaluation(value);
    await value.repository.commitEvaluation({ ...first, assessment: pdAssessment(), draft: advice(), at });
    const next = await evaluation(value, "m1", "预算只有 10 万");
    next.context.issues = [];
    expect(await value.repository.commitEvaluation({ ...next, assessment: pdAssessment(), draft: advice(), at })).toBe("blocked");
    expect((await value.pool.query("SELECT last_error FROM proactive_discussion_jobs WHERE id=$1", [next.job.id])).rows[0].last_error).toBe("incomplete_catalog");
    expect((await value.repository.readState(PILOT_CHAT)).issues).toHaveLength(1);
  });

  async function sentIssue(value: Database) {
    const first = await evaluation(value);
    await value.repository.commitEvaluation({ ...first, assessment: pdAssessment(), draft: advice(), at });
    await value.pool.query(`UPDATE proactive_discussion_deliveries SET state='sent',reply_message_id='sent-reply',attempted_at=$1,sent_at=$1`, [at]);
    return (await value.repository.readState(PILOT_CHAT)).issues[0]!;
  }
  async function feedbackJob(value: Database, id: string, action: "pause" | "resume") {
    const text = action === "pause" ? "不再跟进这件事" : "恢复跟进这件事";
    await message(value, id, text);
    await value.repository.register({ ...registration(id, text), purpose: "feedback",
      feedback: { action, actorOpenId: "test-human", replyMessageId: "sent-reply" } });
    return (await value.repository.claimEvaluation({ workerId: "feedback", at, leaseUntil: time(30) }))!;
  }
  const feedbackInput = (job: Awaited<ReturnType<typeof feedbackJob>>, issueId: string, expectedIssueVersion: number) => ({
    job, action: job.feedback!.action, issueId, expectedIssueVersion, verifiedReplyMessageId: "sent-reply",
    actorOpenId: "test-human", verifiedMessage: { chatId: PILOT_CHAT, messageId: job.messageId, contentHash: job.contentHash }, at,
  });

  test("real receipt feedback pauses indefinitely, resumes observing and never resends old advice", async () => {
    const value = await evaluationSetup();
    const issue = await sentIssue(value);
    expect(await value.repository.findIssueByReply({ chatId: PILOT_CHAT, replyMessageId: "forged" })).toBeNull();
    expect(await value.repository.findIssueByReply({ chatId: "other", replyMessageId: "sent-reply" })).toBeNull();
    expect(await value.repository.findIssueByReply({ chatId: PILOT_CHAT, replyMessageId: "sent-reply" })).toMatchObject({ id: issue.id });
    const job = await feedbackJob(value, "pause", "pause");
    const input = feedbackInput(job, issue.id, issue.version);
    expect(await value.repository.applyFeedback(input)).toBe("applied");
    expect(await value.repository.applyFeedback(input)).toBe("duplicate");
    expect((await value.repository.readState(PILOT_CHAT)).issues[0]).toMatchObject({ state: "user_paused", version: 2, basisVersion: 1 });
    expect(await value.repository.claimEvaluation({ workerId: "much-later", at: time(1000000), leaseUntil: time(1000010) })).toBeNull();
    const resume = await feedbackJob(value, "resume", "resume");
    expect(await value.repository.applyFeedback(feedbackInput(resume, issue.id, 2))).toBe("applied");
    expect((await value.repository.readState(PILOT_CHAT)).issues[0]).toMatchObject({ state: "observing", version: 3, basisVersion: 1 });
    expect((await value.pool.query("SELECT * FROM proactive_discussion_deliveries")).rows).toHaveLength(1);
    const events = (await value.pool.query("SELECT payload FROM proactive_discussion_events WHERE entity_type='job' AND entity_id=$1", [job.id])).rows;
    expect(events.some(row => row.payload.feedback?.actorOpenId === "test-human" && row.payload.state === "completed")).toBe(true);
  });

  test.each(["version", "actor", "reply", "hash", "deleted"])("feedback transaction blocks changed %s proof", async invalid => {
    const value = await evaluationSetup();
    const issue = await sentIssue(value);
    const job = await feedbackJob(value, "pause", "pause");
    const input = feedbackInput(job, issue.id, issue.version);
    if (invalid === "version") input.expectedIssueVersion += 1;
    if (invalid === "actor") input.actorOpenId = "forger";
    if (invalid === "reply") input.verifiedReplyMessageId = "forged";
    if (invalid === "hash") input.verifiedMessage.contentHash = "a".repeat(64);
    if (invalid === "deleted") await value.pool.query(`INSERT INTO conversation_message_deletion_tombstones
      (provider,provider_message_id,conversation_message_id,chat_id) VALUES('feishu','pause','feishu:pause',$1)`, [PILOT_CHAT]);
    expect(await value.repository.applyFeedback(input)).toBe("blocked");
    expect((await value.repository.readState(PILOT_CHAT)).issues[0]).toMatchObject({ state: "observing", version: 1 });
  });

  test.each(["sending", "outcome_unknown"])("%s blocks the same issue while an independent issue prepares immediately", async state => {
    const value = await evaluationSetup();
    const first = await evaluation(value);
    await value.repository.commitEvaluation({ ...first, assessment: pdAssessment(), draft: advice(), at });
    await value.pool.query("UPDATE proactive_discussion_deliveries SET state=$1,attempted_at=$2", [state, at]);
    await message(value, "m3", "新的强制设备成本");
    const next = await evaluation(value, "m3", "新的强制设备成本");
    const binding = { chatId: PILOT_CHAT, messageId: "m3", contentHash: hashLocalMessageText("新的强制设备成本") };
    const source = { kind: "message" as const, ref: createPdSourceRef({ kind: "message", binding }), binding };
    next.context.sources.push(source);
    next.context.items.push({ ref: source.ref, text: "新的强制设备成本" });
    expect(next.context.issues[0]!.hasUnknownDelivery).toBe(true);
    const assessment = { ...pdAssessment(), issueRef: { kind: "existing" as const, id: next.context.issues[0]!.id }, evidenceRefs: [source.ref],
      materialChange: { kind: "new_evidence" as const, explanation: "设备成本实质扩大预算缺口", evidenceRefs: [source.ref] } };
    // Even a caller hiding the derived flag cannot bypass durable state.
    next.context.issues[0]!.hasUnknownDelivery = false;
    expect(await value.repository.commitEvaluation({ ...next, assessment, draft: advice(assessment), at })).toBe("blocked");
    await message(value, "m4", "新的独立成本风险");
    const independent = await evaluation(value, "m4", "新的独立成本风险");
    expect(await value.repository.commitEvaluation({ ...independent, assessment: pdAssessment(), draft: advice(), at })).toBe("prepared");
    expect((await value.repository.readState(PILOT_CHAT)).issues).toHaveLength(2);
  });

  test("a user pause blocks model resolution and materially new evidence even after policy restart", async () => {
    const value = await evaluationSetup();
    const issue = await sentIssue(value);
    const pause = await feedbackJob(value, "pause", "pause");
    await value.repository.applyFeedback(feedbackInput(pause, issue.id, issue.version));
    await value.repository.setPolicy({ policy: { chatId: PILOT_CHAT, version: 2, enabled: true, operatorId: "restart" }, expectedVersion: 1, at });
    await message(value, "m3", "新增加 20 万强制成本");
    const next = await evaluation(value, "m3", "新增加 20 万强制成本", 2);
    const binding = { chatId: PILOT_CHAT, messageId: "m3", contentHash: hashLocalMessageText("新增加 20 万强制成本") };
    const source = { kind: "message" as const, ref: createPdSourceRef({ kind: "message", binding }), binding };
    next.context.sources.push(source);
    next.context.items.push({ ref: source.ref, text: "新增加 20 万强制成本" });
    const assessment = { ...pdAssessment(), issueRef: { kind: "existing" as const, id: issue.id }, evidenceRefs: [source.ref],
      materialChange: { kind: "new_evidence" as const, explanation: "新成本扩大预算缺口", evidenceRefs: [source.ref] } };
    expect(await value.repository.commitEvaluation({ ...next, assessment, draft: advice(assessment), at })).toBe("blocked");
    const resolution = await evaluation(value, "m1", "预算只有 10 万", 2);
    expect(await value.repository.commitEvaluation({ ...resolution,
      assessment: { ...pdSkipAssessment("resolved"), issueRef: { kind: "existing", id: issue.id } }, draft: null, at })).toBe("blocked");
    expect((await value.repository.readState(PILOT_CHAT)).issues[0]).toMatchObject({ state: "user_paused", basisVersion: 1, version: 2 });
    expect((await value.pool.query("SELECT * FROM proactive_discussion_deliveries")).rows).toHaveLength(1);
  });

  test("full catalog blocks its 101st identity before it can degrade all future reads", async () => {
    const value = await evaluationSetup();
    await value.pool.query(`INSERT INTO proactive_discussion_issues
      (id,chat_id,description,state,version,basis_version,last_observation,last_reasoning,last_suggestion,basis_sources)
      SELECT 'bounded-' || i,$1,'budget','observing',1,1,'observation','reasoning','suggestion',$2::jsonb
      FROM generate_series(1,100) AS i`, [PILOT_CHAT, JSON.stringify(pdContext().sources)]);
    const next = await evaluation(value);
    expect(await value.repository.commitEvaluation({ ...next, assessment: pdAssessment(), draft: advice(), at })).toBe("blocked");
    expect((await value.repository.readState(PILOT_CHAT)).issues).toHaveLength(100);
  });

  test("feedback job cannot be repurposed by an assessment caller", async () => {
    const value = await evaluationSetup();
    const job = await feedbackJob(value, "pause", "pause");
    const state = await value.repository.readState(PILOT_CHAT);
    const context = { ...pdContext(), ...state, policy: state.policy!, triggerMessageId: job.messageId };
    expect(await value.repository.commitEvaluation({ job, context, assessment: pdAssessment(), draft: advice(), at })).toBe("blocked");
    expect((await value.repository.readState(PILOT_CHAT)).issues).toEqual([]);
  });

  test("verified mention registration round-trips and negative feedback proof cancels without technical dead letter", async () => {
    const value = await evaluationSetup();
    const issue = await sentIssue(value);
    const text = "@_user_1 不再跟进这件事";
    await message(value, "mention", text);
    const input = { ...registration("mention", text), purpose: "feedback" as const,
      feedback: { action: "pause" as const, replyMessageId: "sent-reply", actorOpenId: "test-human", irisMentionKey: "@_user_1" } };
    expect(await value.repository.register({ ...input, feedback: { ...input.feedback, irisMentionKey: "@Iris" } })).toBe("blocked");
    expect(await value.repository.register(input)).toBe("registered");
    const job = (await value.repository.claimEvaluation({ workerId: "mention", at, leaseUntil: time(30) }))!;
    expect(job.feedback?.irisMentionKey).toBe("@_user_1");
    expect(await value.repository.applyFeedback(feedbackInput(job, issue.id, issue.version))).toBe("applied");
    const bad = await feedbackJob(value, "negative", "pause");
    await value.repository.failEvaluation({ job: bad, reason: "feedback_blocked", retryable: false, at });
    expect((await value.pool.query("SELECT state FROM proactive_discussion_jobs WHERE id=$1", [bad.id])).rows[0].state).toBe("cancelled");
    expect((await value.repository.getStatus()).deadLetter).toBe(0);
  });

  test("repeated stale contexts preserve technical attempts and let other jobs run without extending debounce", async () => {
    const value = await evaluationSetup();
    const first = await evaluation(value);
    await value.repository.failEvaluation({ job: first.job, reason: "technical", retryable: true, at });
    let job = (await value.repository.claimEvaluation({ workerId: "retry", at: time(1), leaseUntil: time(30) }))!;
    expect(job.attempt).toBe(2);
    for (let index = 0; index < 5; index++) {
      expect(await value.repository.commitEvaluation({ job, context: { ...first.context, contextVersion: 1 },
        assessment: pdAssessment(), draft: advice(), at: time(index + 1) })).toBe("stale");
      job = (await value.repository.claimEvaluation({ workerId: "retry", at: time(index + 2), leaseUntil: time(30) }))!;
      expect(job.id).toBe(first.job.id);
      expect(job.attempt).toBe(2);
    }
    await value.repository.register(registration("m1", "预算只有 10 万"));
    await value.repository.requeueEvaluation({ job, at: time(7) });
    const other = (await value.repository.claimEvaluation({ workerId: "other", at: time(7), leaseUntil: time(30) }))!;
    expect(other.messageId).toBe("m1");
    expect(await value.repository.commitEvaluation({ job: other, context: { ...first.context, triggerMessageId: "m1" },
      assessment: pdSkipAssessment(), draft: null, at: time(7) })).toBe("skipped");
    const last = (await value.repository.claimEvaluation({ workerId: "last", at: time(8), leaseUntil: time(30) }))!;
    expect(await value.repository.commitEvaluation({ job: last, context: first.context, assessment: pdAssessment(), draft: advice(), at: time(8) })).toBe("prepared");
    expect((await value.repository.getStatus()).deadLetter).toBe(0);
    expect((await value.pool.query("SELECT * FROM proactive_discussion_evaluations WHERE job_id=$1", [first.job.id])).rows).toHaveLength(1);
    expect((await value.pool.query("SELECT * FROM proactive_discussion_jobs")).rows).toHaveLength(2);
  });

  test.each(["policy", "changed", "deleted"])("context-null requeue cancels %s trigger identity", async invalid => {
    const value = await evaluationSetup();
    const first = await evaluation(value);
    if (invalid === "policy") await value.repository.setPolicy({ policy: { ...first.context.policy, version: 2 }, expectedVersion: 1, at });
    if (invalid === "changed") await value.pool.query("UPDATE conversation_messages SET text='corrected' WHERE provider_message_id='m2'");
    if (invalid === "deleted") await value.pool.query("DELETE FROM conversation_messages WHERE provider_message_id='m2'");
    await value.repository.requeueEvaluation({ job: first.job, at });
    expect((await value.pool.query("SELECT state FROM proactive_discussion_jobs WHERE id=$1", [first.job.id])).rows[0].state).toBe("cancelled");
    expect(await value.repository.claimEvaluation({ workerId: "next", at: time(1), leaseUntil: time(30) })).toBeNull();
  });

  test("policy update uses CAS, starts absent and rejects unauthorized groups and invalid versions", async () => {
    const value = await open();
    expect(await value.repository.readState(PILOT_CHAT)).toEqual({ policy: null, contextVersion: 0, catalogVersion: 0, issues: [] });
    const input = { policy: { chatId: PILOT_CHAT, version: 1, enabled: false, operatorId: "test-operator" }, expectedVersion: 0, at };
    expect(await value.repository.setPolicy(input)).toBe("applied");
    expect(await value.repository.setPolicy(input)).toBe("conflict");
    expect((await value.repository.readState(PILOT_CHAT)).policy?.enabled).toBe(false);
    await expect(value.repository.setPolicy({ ...input, policy: { ...input.policy, chatId: "other" } })).rejects.toThrow();
    await expect(value.repository.setPolicy({ ...input, policy: { ...input.policy, version: 3 }, expectedVersion: 1 })).rejects.toThrow();
    const update = { ...input, policy: { ...input.policy, version: 2, enabled: true }, expectedVersion: 1 };
    expect((await Promise.all([value.repository.setPolicy(update), value.repository.setPolicy(update)])).sort()).toEqual(["applied", "conflict"]);
    expect((await value.pool.query("SELECT count(*) FROM proactive_discussion_events WHERE entity_type = 'policy'")).rows[0].count).toBe("2");
  });

  test("register is exact, duplicate-safe, disabled-safe and does not reacquire the outer replay lock", async () => {
    const value = await enabled();
    expect(await value.repository.register(registration())).toBe("blocked");
    await message(value);
    const guard = createPostgresConversationMessageReplayGuard({ dataSource: value.pool });
    expect(await guard.runUnlessDeleted({ identity: { provider: "feishu", providerMessageId: "m1", chatId: PILOT_CHAT },
      effect: () => value.repository.register(registration()) })).toEqual({ status: "active", value: "registered" });
    expect(await value.repository.register(registration())).toBe("duplicate");
    expect(await value.repository.register({ ...registration(), chatId: "other" })).toBe("blocked");
    expect(await value.repository.register({ ...registration(), policyVersion: 2 })).toBe("blocked");
    await value.pool.query("UPDATE conversation_messages SET text = '新预算' WHERE provider_message_id = 'm1'");
    expect(await value.repository.register(registration())).toBe("blocked");
    expect(await value.repository.register(registration("m1", "新预算"))).toBe("registered");
    await value.repository.setPolicy({ policy: { chatId: PILOT_CHAT, version: 2, enabled: false, operatorId: "test-operator" }, expectedVersion: 1, at });
    expect(await value.repository.register({ ...registration("m1", "新预算"), policyVersion: 2 })).toBe("blocked");
    expect(await value.repository.claimEvaluation({ workerId: "worker", at, leaseUntil: time(10) })).toBeNull();
    expect((await value.repository.getStatus()).pending).toBe(0);
  });

  test("context version tracks message identity, moves and tombstones atomically but not replay keys", async () => {
    const value = await enabled();
    const version = async (chat = PILOT_CHAT) => (await value.repository.readState(chat)).contextVersion;
    expect(await version()).toBe(1);
    await message(value);
    expect(await version()).toBe(2);
    await value.pool.query("UPDATE conversation_messages SET raw_event_idempotency_key = 'retry' WHERE provider_message_id = 'm1'");
    expect(await version()).toBe(2);
    await value.pool.query("UPDATE conversation_messages SET text = 'changed' WHERE provider_message_id = 'm1'");
    expect(await version()).toBe(3);
    await value.pool.query("UPDATE conversation_messages SET sender_open_id = 'test-human-2' WHERE provider_message_id = 'm1'");
    expect(await version()).toBe(4);
    await value.pool.query("UPDATE conversation_messages SET message_type = 'post' WHERE provider_message_id = 'm1'");
    expect(await version()).toBe(5);
    const eventsBeforeRollback = (await value.pool.query("SELECT count(*) FROM proactive_discussion_events")).rows[0].count;
    const client = await value.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("UPDATE conversation_messages SET text = 'rolled back' WHERE provider_message_id = 'm1'");
      expect((await client.query("SELECT context_version FROM proactive_discussion_groups WHERE chat_id = $1", [PILOT_CHAT])).rows[0].context_version).toBe("6");
      await client.query("ROLLBACK");
    } finally { client.release(); }
    expect(await version()).toBe(5);
    expect((await value.pool.query("SELECT count(*) FROM proactive_discussion_events")).rows[0].count).toBe(eventsBeforeRollback);
    await value.pool.query(`INSERT INTO proactive_discussion_policies (chat_id,version,enabled,operator_id,updated_at)
      VALUES ('test-other',1,false,'test-operator',$1)`, [at]);
    await value.pool.query("UPDATE conversation_messages SET chat_id = 'test-other' WHERE provider_message_id = 'm1'");
    expect(await version()).toBe(6);
    expect(await version("test-other")).toBe(2);
    await value.pool.query(`INSERT INTO conversation_message_deletion_tombstones
      (provider,provider_message_id,conversation_message_id,chat_id) VALUES ('feishu','m1','feishu:m1','test-other')`);
    expect(await version("test-other")).toBe(3);
    expect(await value.repository.register(registration("m1", "changed"))).toBe("blocked");
    await value.pool.query("DELETE FROM conversation_messages WHERE provider_message_id = 'm1'");
    expect(await version("test-other")).toBe(4);
    await message(value, "outside", "outside", "unregistered");
    expect(await version("unregistered")).toBe(0);
    expect((await value.pool.query("SELECT count(*) FROM proactive_discussion_groups")).rows[0].count).toBe("2");
  });

  test("tombstone prevents new work even while the stored message remains", async () => {
    const value = await enabled();
    await message(value);
    await value.pool.query(`INSERT INTO conversation_message_deletion_tombstones
      (provider,provider_message_id,conversation_message_id,chat_id) VALUES ('feishu','m1','feishu:m1',$1)`, [PILOT_CHAT]);
    expect(await value.repository.register(registration())).toBe("blocked");
  });

  test("feedback registration preserves the direct actor identity and purpose without applying feedback", async () => {
    const value = await enabled();
    await message(value, "m1", "不再跟进这件事");
    const registerFeedback = { ...registration("m1", "不再跟进这件事"), purpose: "feedback" as const };
    const feedback = { action: "pause" as const, replyMessageId: "reply-1", actorOpenId: "test-human" };
    expect(await value.repository.register(registerFeedback)).toBe("blocked");
    expect(await value.repository.register({ ...registerFeedback, feedback: { ...feedback, actorOpenId: "forged" } })).toBe("blocked");
    expect(await value.repository.register({ ...registerFeedback, feedback })).toBe("registered");
    expect(await value.repository.claimEvaluation({ workerId: "w", at, leaseUntil: time(10) })).toMatchObject({ purpose: "feedback", feedback });
    expect((await value.repository.readState(PILOT_CHAT)).issues).toEqual([]);
  });

  test("parallel claims are unique and expired lease tokens cannot settle replacement work", async () => {
    const value = await enabled();
    await message(value);
    await value.repository.register(registration());
    const claims = await Promise.all(Array.from({ length: 8 }, (_, i) => value.repository.claimEvaluation({ workerId: `w${i}`, at, leaseUntil: time(10) })));
    const claimed = claims.filter(item => item !== null);
    expect(claimed).toHaveLength(1);
    expect(claimed[0]?.attempt).toBe(1);
    const replacement = await value.repository.claimEvaluation({ workerId: "replacement", at: time(11), leaseUntil: time(20) });
    expect(replacement?.attempt).toBe(2);
    expect(replacement?.leaseToken).not.toBe(claimed[0]?.leaseToken);
    await value.repository.failEvaluation({ job: claimed[0]!, reason: "old owner", retryable: false, at: time(12) });
    expect((await value.repository.getStatus()).deadLetter).toBe(0);
    await value.repository.failEvaluation({ job: replacement!, reason: "current owner", retryable: false, at: time(12) });
    expect(await value.repository.getStatus()).toMatchObject({ pending: 0, failed: 1, deadLetter: 1, unknown: 0 });
  });

  test("evaluation errors back off 1 then 5 seconds, stop after three attempts and remain auditable", async () => {
    const value = await enabled();
    await message(value);
    await value.repository.register(registration());
    for (const [index, second] of [0, 1, 6].entries()) {
      const job = await value.repository.claimEvaluation({ workerId: "worker", at: time(second), leaseUntil: time(second + 10) });
      expect(job?.attempt).toBe(index + 1);
      await value.repository.failEvaluation({ job: job!, reason: "model unavailable", retryable: true, at: time(second) });
      expect(await value.repository.claimEvaluation({ workerId: "early", at: time(second), leaseUntil: time(second + 10) })).toBeNull();
    }
    expect(await value.repository.claimEvaluation({ workerId: "late", at: time(100), leaseUntil: time(110) })).toBeNull();
    expect(await value.repository.getStatus()).toEqual({ pending: 0, failed: 1, deadLetter: 1, unknown: 0, lastSuccessAt: null });
    const events = await value.pool.query("SELECT operation FROM proactive_discussion_events WHERE entity_type = 'job'");
    expect(events.rows).toHaveLength(7);
    await expect(value.pool.query("DELETE FROM proactive_discussion_events")).rejects.toThrow(/append-only/iu);
    await expect(value.pool.query("UPDATE proactive_discussion_events SET operation = 'fake'")).rejects.toThrow(/append-only/iu);
  });

  test("schema preserves exact source facts, delivery identities and truthful sent receipts", async () => {
    const value = await enabled();
    await message(value);
    await value.repository.register(registration());
    const job = await value.repository.claimEvaluation({ workerId: "w", at, leaseUntil: time(10) });
    await value.pool.query(`INSERT INTO proactive_discussion_issues
      (id,chat_id,description,state,version,basis_version,last_observation,last_reasoning,last_suggestion,basis_sources)
      VALUES ('issue',$1,'budget','observing',1,1,'observation','reasoning','suggestion',$2::jsonb)`, [PILOT_CHAT, JSON.stringify(pdContext().sources)]);
    await value.pool.query(`INSERT INTO proactive_discussion_evaluations
      (id,job_id,attempt,chat_id,context_version,catalog_version,policy_version,assessment,draft)
      VALUES ('evaluation',$1,1,$2,2,1,1,'{}','null')`, [job!.id, PILOT_CHAT]);
    const insertDelivery = (id: string, basis = 1, uuid = "reply-uuid", state = "prepared", receipt: string | null = null, authorization = "policy") =>
      value.pool.query(`INSERT INTO proactive_discussion_deliveries
        (id,chat_id,issue_id,issue_version,basis_version,policy_version,context_version,trigger_message_id,text,reply_uuid,state,authorization_kind,reply_message_id)
        VALUES ($1,$2,'issue',1,$3,1,2,'m1','budget advice',$4,$5,$6,$7)`, [id, PILOT_CHAT, basis, uuid, state, authorization, receipt]);
    await insertDelivery("delivery");
    await expect(insertDelivery("duplicate-basis", 1, "other-uuid")).rejects.toMatchObject({ code: "23505" });
    await expect(insertDelivery("duplicate-uuid", 2)).rejects.toMatchObject({ code: "23505" });
    await expect(insertDelivery("false-approval", 2, "new-uuid", "prepared", null, "human_approved")).rejects.toMatchObject({ code: "23514" });
    await expect(insertDelivery("false-success", 2, "new-uuid", "sent")).rejects.toMatchObject({ code: "23514" });
    await expect(insertDelivery("blank-success", 2, "new-uuid", "sent", " ")).rejects.toMatchObject({ code: "23514" });
    const source = pdContext().sources[0]!;
    await value.pool.query(`INSERT INTO proactive_discussion_sources
      (evaluation_id,source_index,kind,ref,binding) VALUES ('evaluation',0,$1,$2,$3::jsonb)`, [source.kind, source.ref, JSON.stringify(source.binding)]);
    await value.pool.query(`INSERT INTO proactive_discussion_sources
      (delivery_id,source_index,kind,ref,binding) VALUES ('delivery',0,$1,$2,$3::jsonb)`, [source.kind, source.ref, JSON.stringify(source.binding)]);
    await expect(value.pool.query("DELETE FROM proactive_discussion_evaluations")).rejects.toThrow(/append-only/iu);
    await expect(value.pool.query("UPDATE proactive_discussion_evaluations SET assessment = '{}'::jsonb")).rejects.toThrow(/append-only/iu);
    await expect(value.pool.query("DELETE FROM proactive_discussion_sources")).rejects.toThrow(/append-only/iu);
    await expect(value.pool.query("UPDATE proactive_discussion_sources SET ref = 'changed'")).rejects.toThrow(/append-only/iu);
    expect((await value.repository.readState(PILOT_CHAT)).issues[0]).toMatchObject({ id: "issue", basisSources: pdContext().sources, hasUnknownDelivery: false });
  });

  test("catalog capacity degrades explicitly instead of returning a misleading partial catalog", async () => {
    const value = await enabled();
    await value.pool.query(`INSERT INTO proactive_discussion_issues
      (id,chat_id,description,state,version,basis_version,last_observation,last_reasoning,last_suggestion,basis_sources)
      SELECT 'issue-' || i,$1,'budget','observing',1,1,'observation','reasoning','suggestion','[]'::jsonb
      FROM generate_series(1,101) AS i`, [PILOT_CHAT]);
    await expect(value.repository.readState(PILOT_CHAT)).rejects.toMatchObject({ code: "proactive_discussion_catalog_degraded" });
  });

  test("three crashed evaluation leases become dead-letter and cannot retry forever", async () => {
    const value = await enabled();
    await message(value);
    await value.repository.register(registration());
    for (const second of [0, 11, 22]) {
      expect(await value.repository.claimEvaluation({ workerId: "crasher", at: time(second), leaseUntil: time(second + 10) })).not.toBeNull();
    }
    expect(await value.repository.claimEvaluation({ workerId: "fourth", at: time(33), leaseUntil: time(43) })).toBeNull();
    expect((await value.repository.getStatus()).deadLetter).toBe(1);
  });

  test("local answer traces preserve exact message bindings and reject later mutation", async () => {
    const value = await open();
    await value.pool.query(`INSERT INTO answer_reply_deliveries
      (id,provider,incoming_message_id,chat_id,reply_uuid,safe_notice_uuid,state,
       prepared_reply_text,rendered_reply_fingerprint,semantic_fingerprint,created_at,updated_at)
      VALUES ('answer','feishu','incoming',$1,'answer-uuid','notice-uuid','prepared',
        'answer',repeat('a',64),repeat('b',64),$2,$2)`, [PILOT_CHAT, at]);
    await value.pool.query(`INSERT INTO answer_reply_local_source_traces
      (delivery_id,trace_index,chat_id,message_id,content_hash) VALUES ('answer',0,$1,'m1',$2)`, [PILOT_CHAT, hashLocalMessageText("预算只有 10 万")]);
    await expect(value.pool.query(`INSERT INTO answer_reply_local_source_traces
      (delivery_id,trace_index,chat_id,message_id,content_hash) VALUES ('answer',0,$1,'m2',repeat('b',64))`, [PILOT_CHAT])).rejects.toMatchObject({ code: "23505" });
    await expect(value.pool.query("UPDATE answer_reply_local_source_traces SET message_id = 'changed'")).rejects.toThrow(/append-only/iu);
    await expect(value.pool.query("DELETE FROM answer_reply_local_source_traces")).rejects.toThrow(/append-only/iu);
  });
});
