import { randomUUID } from "node:crypto";
import type { PostgresConversationStateDataSource, TransactionClient } from "../conversation-state/postgres-conversation-state-repository.js";
import { hashLocalMessageText } from "../memory/local-message-source.js";
import { PD_PILOT_CHAT, type PdIssue, type PdJob, type PdPolicy, type PdSource } from "./contracts.js";
import { PdCatalogCapacityError, type PdFoundationRepository } from "./repository.js";

type Row = Record<string, unknown>;

export function createPostgresProactiveDiscussionRepository({ dataSource }: {
  dataSource: PostgresConversationStateDataSource;
}): PdFoundationRepository {
  return {
    async setPolicy({ policy, expectedVersion, at }) {
      if (policy.chatId !== PD_PILOT_CHAT) throw new Error("proactive discussion policy is restricted to the exact pilot");
      safeInteger(expectedVersion, 0);
      safeInteger(policy.version, 1);
      if (policy.version !== expectedVersion + 1) throw new Error("policy version must advance by one");
      identifier(policy.operatorId, 256);
      if (typeof policy.enabled !== "boolean") throw new Error("invalid policy enabled state");
      date(at);
      return transaction(dataSource, async client => {
        // This operation never takes a message lock. Registration does not take
        // this lock or a policy row lock while holding its outer replay guard.
        await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`iris:proactive-discussion:policy:${policy.chatId}`]);
        const current = await client.query("SELECT version FROM proactive_discussion_policies WHERE chat_id=$1", [policy.chatId]);
        if ((current.rows[0] ? safeInteger(current.rows[0].version, 1) : 0) !== expectedVersion) return "conflict";
        await client.query(`INSERT INTO proactive_discussion_policies(chat_id,version,enabled,operator_id,updated_at)
          VALUES ($1,$2,$3,$4,$5) ON CONFLICT(chat_id) DO UPDATE SET version=EXCLUDED.version,
          enabled=EXCLUDED.enabled,operator_id=EXCLUDED.operator_id,updated_at=EXCLUDED.updated_at`,
        [policy.chatId, policy.version, policy.enabled, policy.operatorId, at]);
        return "applied";
      });
    },

    async register(input) {
      if (input.chatId !== PD_PILOT_CHAT || !isIdentifier(input.messageId, 505)
        || !/^[a-f0-9]{64}$/u.test(input.contentHash)
        || !Number.isSafeInteger(input.policyVersion) || input.policyVersion < 1
        || !["assessment", "feedback"].includes(input.purpose)) return "blocked";
      if (input.purpose === "assessment" && input.feedback !== undefined) return "blocked";
      if (input.purpose === "feedback" && (!input.feedback || !["pause", "resume"].includes(input.feedback.action)
        || !isIdentifier(input.feedback.replyMessageId, 505) || !isIdentifier(input.feedback.actorOpenId, 512))) return "blocked";
      date(input.at);
      return transaction(dataSource, async client => {
        // Caller holds the existing message replay guard across persistence and
        // registration. Do not reacquire it on this connection. The fact write
        // and its context trigger are atomic; a crash before this separate job
        // transaction is repaired by replay of the raw event.
        const current = await client.query(`SELECT m.text,m.sender_open_id FROM conversation_messages m
          JOIN proactive_discussion_policies p ON p.chat_id=m.chat_id
          WHERE m.provider='feishu' AND m.provider_message_id=$1 AND m.chat_id=$2
            AND p.enabled AND p.version=$3 AND NOT EXISTS
              (SELECT 1 FROM conversation_message_deletion_tombstones t
               WHERE t.provider=m.provider AND t.provider_message_id=m.provider_message_id)`,
        [input.messageId, input.chatId, input.policyVersion]);
        const message = current.rows[0];
        if (!message || typeof message.text !== "string" || hashLocalMessageText(message.text) !== input.contentHash
          || (input.feedback && message.sender_open_id !== input.feedback.actorOpenId)) return "blocked";
        const inserted = await client.query(`INSERT INTO proactive_discussion_jobs
          (id,chat_id,message_id,content_hash,policy_version,purpose,feedback,available_at,created_at,updated_at)
          VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$8,$8)
          ON CONFLICT(chat_id,message_id,content_hash,policy_version,purpose) DO NOTHING RETURNING id`,
        [randomUUID(), input.chatId, input.messageId, input.contentHash, input.policyVersion, input.purpose,
          input.feedback ? JSON.stringify(input.feedback) : null, input.at]);
        return inserted.rows.length === 1 ? "registered" : "duplicate";
      });
    },

    async readState(chatId) {
      identifier(chatId, 512);
      return transaction(dataSource, async client => {
        const policyRows = await client.query("SELECT * FROM proactive_discussion_policies WHERE chat_id=$1", [chatId]);
        const groupRows = await client.query("SELECT context_version,catalog_version FROM proactive_discussion_groups WHERE chat_id=$1", [chatId]);
        const issueRows = await client.query(`SELECT i.*, EXISTS
          (SELECT 1 FROM proactive_discussion_deliveries d WHERE d.issue_id=i.id AND d.state='outcome_unknown') AS unknown_delivery
          FROM proactive_discussion_issues i WHERE i.chat_id=$1 ORDER BY i.id LIMIT 101`, [chatId]);
        if (issueRows.rows.length > 100) throw new PdCatalogCapacityError();
        const group = groupRows.rows[0];
        return { policy: policyRows.rows[0] ? decodePolicy(policyRows.rows[0]) : null,
          contextVersion: group ? safeInteger(group.context_version, 1) : 0,
          catalogVersion: group ? safeInteger(group.catalog_version, 1) : 0,
          issues: issueRows.rows.map(decodeIssue) };
      }, true);
    },

    async claimEvaluation({ workerId, at, leaseUntil }) {
      identifier(workerId, 256);
      date(at); date(leaseUntil);
      if (leaseUntil.getTime() <= at.getTime()) throw new Error("lease must end after claim time");
      return transaction(dataSource, async client => {
        // Bounded cleanup prevents stale/disabled policies and crashed jobs from
        // stranding the queue. All transitions append events through the trigger.
        for (let scanned = 0; scanned < 100; scanned++) {
          const result = await client.query(`SELECT * FROM proactive_discussion_jobs
            WHERE (state IN ('pending','retry') AND available_at <= $1)
              OR (state='processing' AND lease_until <= $1)
            ORDER BY available_at,id FOR UPDATE SKIP LOCKED LIMIT 1`, [at]);
          const row = result.rows[0];
          if (!row) return null;
          const attempts = safeInteger(row.attempts, 0);
          const active = await client.query(`SELECT 1 FROM proactive_discussion_policies
            WHERE chat_id=$1 AND chat_id=$2 AND version=$3 AND enabled`, [row.chat_id, PD_PILOT_CHAT, row.policy_version]);
          if (active.rows.length === 0 || attempts >= 3) {
            await client.query(`UPDATE proactive_discussion_jobs SET state=$2,version=version+1,
              lease_token=NULL,lease_until=NULL,worker_id=NULL,last_error=$3,updated_at=$4 WHERE id=$1`,
            [row.id, active.rows.length === 0 ? "cancelled" : "dead_letter",
              active.rows.length === 0 ? "policy_inactive" : "evaluation_lease_exhausted", at]);
            continue;
          }
          const leased = await client.query(`UPDATE proactive_discussion_jobs SET state='processing',version=version+1,
            lease_token=$2,lease_until=$3,worker_id=$4,attempts=attempts+1,updated_at=$5 WHERE id=$1 RETURNING *`,
          [row.id, randomUUID(), leaseUntil, workerId, at]);
          return decodeJob(leased.rows[0]!);
        }
        return null;
      });
    },

    async failEvaluation({ job, reason, retryable, at }) {
      date(at); identifier(job.id, 512); identifier(job.leaseToken, 512);
      safeInteger(job.attempt, 1); safeInteger(job.policyVersion, 1);
      const terminal = !retryable || job.attempt >= 3;
      const availableAt = new Date(at.getTime() + (job.attempt === 1 ? 1000 : 5000));
      date(availableAt);
      await transaction(dataSource, async client => {
        await client.query(`UPDATE proactive_discussion_jobs SET state=$6,version=version+1,
          lease_token=NULL,lease_until=NULL,worker_id=NULL,last_error=$7,available_at=$8,updated_at=$9
          WHERE id=$1 AND chat_id=$2 AND policy_version=$3 AND lease_token=$4 AND attempts=$5
            AND state='processing' AND lease_until > $9`,
        [job.id, job.chatId, job.policyVersion, job.leaseToken, job.attempt,
          terminal ? "dead_letter" : "retry", String(reason).slice(0, 2000), availableAt, at]);
      });
    },

    async getStatus() {
      const result = await dataSource.query(`SELECT
        (SELECT count(*) FROM proactive_discussion_jobs WHERE state IN ('pending','processing','retry')) +
          (SELECT count(*) FROM proactive_discussion_deliveries WHERE state IN ('prepared','sending')) AS pending,
        (SELECT count(*) FROM proactive_discussion_jobs WHERE state IN ('retry','dead_letter')) AS failed,
        (SELECT count(*) FROM proactive_discussion_jobs WHERE state='dead_letter') AS dead_letter,
        (SELECT count(*) FROM proactive_discussion_deliveries WHERE state='outcome_unknown') AS unknown,
        (SELECT max(sent_at) FROM proactive_discussion_deliveries WHERE state='sent') AS last_success_at`);
      const row = result.rows[0]!;
      return { pending: safeInteger(row.pending, 0), failed: safeInteger(row.failed, 0),
        deadLetter: safeInteger(row.dead_letter, 0), unknown: safeInteger(row.unknown, 0),
        lastSuccessAt: row.last_success_at === null ? null : date(new Date(row.last_success_at as string | Date)) };
    },
  };
}

async function transaction<T>(source: PostgresConversationStateDataSource,
  operation: (client: TransactionClient) => Promise<T>, readOnly = false): Promise<T> {
  const client = await source.connect();
  try {
    await client.query(readOnly ? "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY" : "BEGIN");
    const value = await operation(client);
    await client.query("COMMIT");
    return value;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally { client.release(); }
}

function safeInteger(value: unknown, minimum: number): number {
  if (typeof value !== "number" && (typeof value !== "string" || !/^[0-9]+$/u.test(value))) throw new Error("invalid database integer");
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum) throw new Error("invalid database integer");
  return parsed;
}
function isIdentifier(value: unknown, maximum: number): value is string {
  return typeof value === "string" && value.length >= 1 && value.length <= maximum && value.trim() === value;
}
function identifier(value: unknown, maximum: number): string {
  if (!isIdentifier(value, maximum)) throw new Error("invalid identifier");
  return value;
}
function date(value: Date): Date {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) throw new Error("invalid date");
  return value;
}
function decodePolicy(row: Row): PdPolicy {
  if (typeof row.enabled !== "boolean") throw new Error("invalid policy state");
  return { chatId: identifier(row.chat_id, 512), version: safeInteger(row.version, 1), enabled: row.enabled,
    operatorId: identifier(row.operator_id, 256) };
}
function decodeJob(row: Row): PdJob {
  if (row.purpose !== "assessment" && row.purpose !== "feedback") throw new Error("invalid job purpose");
  return { id: identifier(row.id, 512), chatId: identifier(row.chat_id, 512), messageId: identifier(row.message_id, 505),
    contentHash: String(row.content_hash), policyVersion: safeInteger(row.policy_version, 1),
    leaseToken: identifier(row.lease_token, 512), attempt: safeInteger(row.attempts, 1), purpose: row.purpose,
    ...(row.feedback === null ? {} : { feedback: row.feedback as PdJob["feedback"] }) };
}
function decodeIssue(row: Row): PdIssue {
  if (!["observing", "surfaced", "resolved", "user_paused"].includes(String(row.state))) throw new Error("invalid issue state");
  if (!Array.isArray(row.basis_sources)) throw new Error("invalid issue sources");
  for (const source of row.basis_sources as PdSource[]) {
    if (source.kind === "document" && source.binding.crossGroupGrantVersion !== undefined) safeInteger(source.binding.crossGroupGrantVersion, 1);
  }
  return { id: identifier(row.id, 512), chatId: identifier(row.chat_id, 512), description: String(row.description),
    state: row.state as PdIssue["state"], version: safeInteger(row.version, 1), basisVersion: safeInteger(row.basis_version, 1),
    lastObservation: String(row.last_observation), lastReasoning: String(row.last_reasoning), lastSuggestion: String(row.last_suggestion),
    basisSources: row.basis_sources as PdSource[], hasUnknownDelivery: row.has_unknown_delivery === true || row.unknown_delivery === true };
}
