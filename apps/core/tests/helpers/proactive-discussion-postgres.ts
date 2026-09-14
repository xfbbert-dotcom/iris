import { randomUUID } from "node:crypto";
import pg from "pg";
import { defaultMigrationsDir, runMigrations } from "../../src/database/migrate.js";
import type { PdRepository } from "../../src/proactive-discussion/repository.js";
import { pdContext, pdAssessment, PILOT_CHAT } from "../fixtures/proactive-discussion.js";
import { hashLocalMessageText } from "../../src/memory/local-message-source.js";
import { createPdSourceRef } from "../../src/proactive-discussion/contracts.js";
import { createPostgresDocumentSourceGroupGrantRepository } from "../../src/documents/postgres-document-source-group-grant-repository.js";

export async function openPdDatabase(): Promise<{
  pool: pg.Pool; repository: PdRepository; close(): Promise<void>;
}> {
  const connectionString = process.env.IRIS_TEST_DATABASE_URL?.trim();
  if (!connectionString) throw new Error("IRIS_TEST_DATABASE_URL must name an isolated test database");
  const { createPostgresProactiveDiscussionRepository } = await import("../../src/proactive-discussion/postgres-repository.js");
  const schema = `pd_${randomUUID().replaceAll("-", "")}`;
  const admin = new pg.Pool({ connectionString });
  const pool = new pg.Pool({ connectionString,
    options: `-c search_path=${schema},public -c statement_timeout=3000`, max: 12 });
  let closed = false;
  async function close(): Promise<void> {
    if (closed) return;
    closed = true;
    try { await pool.end(); }
    finally {
      try {
        if (!/^pd_[a-f0-9]{32}$/u.test(schema)) throw new Error("invalid disposable schema");
        await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      } finally { await admin.end(); }
    }
  }
  try {
    const client = await admin.connect();
    try {
      await client.query(`CREATE SCHEMA ${schema}`);
      await client.query(`SET search_path TO ${schema}, public`);
      await runMigrations({ client, migrationsDir: defaultMigrationsDir() });
    } finally { client.release(); }
    return { pool, repository: createPostgresProactiveDiscussionRepository({ dataSource: pool }), close };
  } catch (error) { await close(); throw error; }
}

export const pdTestAt = new Date("2026-09-14T00:00:00Z");
export const pdTestTime = (seconds: number) => new Date(pdTestAt.getTime() + seconds * 1000);

export async function preparePdDelivery(db: Awaited<ReturnType<typeof openPdDatabase>>, historyOnly = false, document?: "ordinary" | "grant") {
  const context = pdContext();
  await db.repository.setPolicy({ policy: context.policy, expectedVersion: 0, at: pdTestAt });
  await db.pool.query(`UPDATE runtime_control_state SET desired_global_enabled=true,
    capabilities=jsonb_set(jsonb_set(capabilities,'{readGroupContext}','true'),'{proactiveSpeech}','true')`);
  for (const [index, source] of context.sources.entries()) {
    if (source.kind !== "message" || (historyOnly && source.binding.messageId === "m1")) continue;
    await db.pool.query(`INSERT INTO conversation_messages
      (id,provider,provider_message_id,chat_id,message_type,text,sender_open_id,sent_at,raw_event_idempotency_key)
      VALUES($1,'feishu',$2,$3,'text',$4,'test-human',$5,$2)`,
    [`feishu:${source.binding.messageId}`, source.binding.messageId, PILOT_CHAT, context.items[index]!.text, pdTestAt]);
  }
  if (document) {
    await db.pool.query(`INSERT INTO document_sources(id,source_type,source_uri,origin_group_id,permission_state,
      sync_state,can_use_for_answering,can_use_for_knowledge_drafts,created_at,updated_at)
      VALUES('doc','group_visible_document','https://synthetic.feishu.cn/docx/test',$1,'readable','synced',true,false,$2,$2)`,
    [document === "grant" ? "owner" : PILOT_CHAT, pdTestAt]);
    await db.pool.query(`INSERT INTO document_snapshots(id,document_source_id,source_uri,fetch_status,body_text,fetched_at,created_at)
      VALUES('snapshot','doc','https://synthetic.feishu.cn/docx/test','succeeded','预算文件',$1,$1)`, [pdTestAt]);
    const grants = document === "grant" ? await createPostgresDocumentSourceGroupGrantRepository({ dataSource: db.pool,
      createId: () => "grant-fixture" }).grant({ documentSourceId: "doc", grantorGroupId: "owner", granteeGroupId: PILOT_CHAT,
      expectedVersion: 0, operationKey: "create-grant", actorRef: "operator", at: pdTestAt }) : null;
    const binding = { documentSourceId: "doc", documentSnapshotId: "snapshot", ...(grants ? {
      crossGroupGrantId: grants.grant.id, crossGroupGrantVersion: grants.grant.version,
      crossGroupGrantorGroupId: "owner", crossGroupGranteeGroupId: PILOT_CHAT } : {}) };
    context.sources.push({ kind: "document", binding, ref: createPdSourceRef({ kind: "document", binding }) });
  }
  await db.repository.register({ chatId: PILOT_CHAT, messageId: "m2",
    contentHash: hashLocalMessageText(context.items[1]!.text), policyVersion: 1, purpose: "assessment", at: pdTestAt });
  const job = await db.repository.claimEvaluation({ workerId: "evaluation", at: pdTestAt, leaseUntil: pdTestTime(60) });
  const state = await db.repository.readState(PILOT_CHAT);
  const result = await db.repository.commitEvaluation({ job: job!, context: { ...context, ...state, policy: state.policy! },
    assessment: pdAssessment(), draft: { text: "两人需要 16 万，建议先核对预算。", evidenceRefs: pdAssessment().evidenceRefs }, at: pdTestAt });
  if (result !== "prepared") throw new Error(`fixture preparation failed: ${result}`);
  return { context, job: job! };
}
