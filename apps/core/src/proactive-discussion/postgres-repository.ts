import { createHash, randomUUID } from "node:crypto";
import { lockAnswerDocumentSources, type AnswerDocumentSourceLockBinding } from "../answer-replies/answer-document-source-locks.js";
import { AnswerReplyGrantStaleError } from "../answer-replies/answer-reply-repository.js";
import { acquireManagedKnowledgeSourceLocks } from "../documents/managed-knowledge-source-lock.js";
import { decodeDurableRuntimeControlSnapshot } from "../admin/runtime-control-state-repository.js";
import { lockConversationMessageIngestScope } from "../conversation/conversation-message-replay-guard.js";
import type { PostgresConversationStateDataSource, TransactionClient } from "../conversation-state/postgres-conversation-state-repository.js";
import { hashLocalMessageText } from "../memory/local-message-source.js";
import { createPdSourceRef, PD_PILOT_CHAT, type PdDelivery, type PdIssue, type PdJob, type PdPolicy, type PdSource } from "./contracts.js";
import { validatePdAssessment } from "./model.js";
import { parsePdFeedback, removePdFeedbackMention } from "./feedback.js";
import { PdCatalogCapacityError, type PdRepository } from "./repository.js";

type Row = Record<string, unknown>;

export function createPostgresProactiveDiscussionRepository({ dataSource }: {
  dataSource: PostgresConversationStateDataSource;
}): PdRepository {
  return {
    async claimDelivery({ workerId, at, leaseUntil }) {
      identifier(workerId, 256); date(at); date(leaseUntil);
      if (leaseUntil <= at) throw new Error("lease must end after claim time");
      return transaction(dataSource, async client => {
        // Only the delivery suffix is locked here. Recovery never retries a send,
        // and reads its runtime proof without waiting for an upstream row lock.
        await client.query(`UPDATE proactive_discussion_deliveries SET state='outcome_unknown',version=version+1,
          last_error='send_lease_expired',updated_at=$1 WHERE id IN
          (SELECT id FROM proactive_discussion_deliveries WHERE state='sending' AND lease_until<=$1
            ORDER BY id LIMIT 100 FOR UPDATE SKIP LOCKED)`, [at]);
        const row = (await client.query(`SELECT * FROM proactive_discussion_deliveries
          WHERE state='prepared' AND attempted_at IS NULL AND (lease_until IS NULL OR lease_until<=$1)
          ORDER BY created_at,id LIMIT 1 FOR UPDATE SKIP LOCKED`, [at])).rows[0];
        if (!row) return null;
        const runtime = await readRuntime(client, false);
        if (!runtime) return null;
        const claimed = (await client.query(`UPDATE proactive_discussion_deliveries SET lease_token=$2,
          worker_id=$3,lease_until=$4,version=version+1,updated_at=$5 WHERE id=$1 RETURNING *`,
        [row.id, randomUUID(), workerId, leaseUntil, at])).rows[0]!;
        return { ...decodeDelivery(claimed, await deliverySources(client, String(row.id))), checkedRuntimeRevision: runtime.revision };
      });
    },
    async beginSend({ delivery, checkedContextVersion, at }) {
      date(at);
      return transaction(dataSource, async client => {
        const initial = (await client.query("SELECT * FROM proactive_discussion_deliveries WHERE id=$1", [delivery.id])).rows[0];
        if (!initial) return "stale";
        const sources = await deliverySources(client, delivery.id);
        const saved = decodeDelivery(initial, sources);
        const evaluationJob = (await client.query(`SELECT j.* FROM proactive_discussion_jobs j
          JOIN proactive_discussion_evaluations e ON e.job_id=j.id WHERE e.id=$1`, [initial.evaluation_id])).rows[0]!;
        const job = { chatId: saved.chatId, policyVersion: saved.policyVersion,
          messageId: saved.triggerMessageId, contentHash: String(evaluationJob.content_hash) };
        const authorized = await lockPolicyRuntime(client, job, delivery.checkedRuntimeRevision);
        const messages = await lockMessages(client, job, sources);
        const documentsValid = await lockDeliveryDocuments(client, sources, saved.chatId);
        const group = (await client.query("SELECT context_version FROM proactive_discussion_groups WHERE chat_id=$1 FOR UPDATE", [saved.chatId])).rows[0];
        const issue = (await client.query(`${issueSelect} WHERE i.id=$1 FOR UPDATE OF i`, [saved.issueId])).rows[0];
        const row = (await client.query("SELECT * FROM proactive_discussion_deliveries WHERE id=$1 FOR UPDATE", [saved.id])).rows[0]!;
        if (row.state !== "prepared" || row.attempted_at !== null || row.lease_token !== delivery.leaseToken
          || !row.lease_until || new Date(row.lease_until as string) <= at
          || !sameDelivery(delivery, decodeDelivery(row, sources))) return "stale";
        const blocked = !authorized || !documentsValid || !issue || issue.state === "user_paused" || issue.state === "resolved"
          || issue.has_unknown_delivery === true || issue.unknown_delivery === true;
        const stale = !messages.trigger || !messages.sourcesValid || !group
          || Number(group.context_version) !== checkedContextVersion || checkedContextVersion !== saved.contextVersion
          || Number(issue?.version) !== saved.issueVersion || Number(issue?.basis_version) !== saved.basisVersion;
        if (blocked || stale) {
          await cancelOwnedDelivery(client, delivery, blocked ? "send_gate_blocked" : "context_stale", at, stale && !blocked);
          return blocked ? "blocked" : "stale";
        }
        await client.query(`UPDATE proactive_discussion_deliveries SET state='sending',attempted_at=$2,
          version=version+1,updated_at=$2 WHERE id=$1`, [delivery.id, at]);
        return "sending";
      });
    },
    async cancelDelivery({ delivery, reason, at }) {
      date(at);
      await transaction(dataSource, async client => {
        await lockDeliveryParents(client, delivery.id);
        await cancelOwnedDelivery(client, delivery, String(reason).slice(0, 2000), at, reason === "context_stale");
      });
    },
    async finishSend({ delivery, outcome, replyMessageId, reason, at }) {
      date(at);
      if (outcome === "sent") identifier(replyMessageId, 505);
      await transaction(dataSource, async client => {
        await lockDeliveryParents(client, delivery.id);
        const changed = (await client.query(`UPDATE proactive_discussion_deliveries SET state=$3,
          reply_message_id=$4,sent_at=$5,last_error=$6,version=version+1,updated_at=$7
          WHERE id=$1 AND lease_token=$2 AND state IN ('sending','outcome_unknown') RETURNING issue_id,chat_id`,
        [delivery.id, delivery.leaseToken, outcome, outcome === "sent" ? replyMessageId : null,
          outcome === "sent" ? at : null, reason?.slice(0, 2000) ?? null, at])).rows[0];
        if (!changed) throw new Error("proactive send receipt ownership lost");
        if (outcome === "sent") {
          await client.query(`UPDATE proactive_discussion_issues SET state='surfaced',version=version+1,updated_at=$2
            WHERE id=$1 AND state='observing'`, [changed.issue_id, at]);
          await advanceCatalog(client, String(changed.chat_id), at);
        }
      });
    },
    // Trusted internal boundary only. Task 7 authenticates the operator and freshly
    // validates receipt chat/sender/body/reply target before calling this method.
    async reconcile({ deliveryId, expectedVersion, operatorId, outcome, replyMessageId, evidence, at }) {
      identifier(operatorId, 256); identifier(evidence, 4000); safeInteger(expectedVersion, 1); date(at);
      if (outcome === "sent") identifier(replyMessageId, 505);
      if (outcome !== "sent" && outcome !== "not_sent") return "blocked";
      return transaction(dataSource, async client => {
        await lockDeliveryParents(client, deliveryId);
        const row = (await client.query("SELECT * FROM proactive_discussion_deliveries WHERE id=$1 FOR UPDATE", [deliveryId])).rows[0];
        if (!row || Number(row.version) !== expectedVersion) return "conflict";
        if (row.state !== "outcome_unknown") return "blocked";
        await client.query(`UPDATE proactive_discussion_deliveries SET state=$2,reply_message_id=$3,sent_at=$4,
          lease_token=NULL,lease_until=NULL,worker_id=NULL,last_error=$5,version=version+1,updated_at=$6 WHERE id=$1`,
        [deliveryId, outcome === "sent" ? "sent" : "cancelled", outcome === "sent" ? replyMessageId : null,
          outcome === "sent" ? at : null, JSON.stringify({ operatorId, evidence, outcome }), at]);
        if (outcome === "sent") await client.query(`UPDATE proactive_discussion_issues SET state='surfaced',version=version+1,
          updated_at=$2 WHERE id=$1 AND state='observing'`, [row.issue_id, at]);
        await advanceCatalog(client, String(row.chat_id), at);
        return "applied";
      });
    },
    async commitEvaluation({ job, context, assessment, draft, at }) {
      date(at);
      return transaction(dataSource, async client => {
        const authorized = await lockPolicyRuntime(client, job);
        const { trigger, sourcesValid } = await lockMessages(client, job, context.sources);
        const group = (await client.query(`SELECT context_version,catalog_version FROM proactive_discussion_groups
          WHERE chat_id=$1 FOR UPDATE`, [job.chatId])).rows[0];
        const issues = (await client.query(`${issueSelect} WHERE i.chat_id=$1 ORDER BY i.id LIMIT 101 FOR UPDATE OF i`, [job.chatId])).rows.map(decodeIssue);
        if (!await lockOwnedJob(client, job, at)) return "stale";
        const finish = async (outcome: "prepared" | "skipped" | "blocked", reason: string | null) => {
          const evaluationId = randomUUID();
          await client.query(`INSERT INTO proactive_discussion_evaluations
            (id,job_id,attempt,chat_id,context_version,catalog_version,policy_version,assessment,draft,outcome,created_at)
            VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,$10,$11)`,
          [evaluationId, job.id, job.attempt, job.chatId, context.contextVersion, context.catalogVersion, job.policyVersion,
            JSON.stringify(assessment), JSON.stringify(draft), outcome, at]);
          await appendSources(client, "evaluation_id", evaluationId, context.sources);
          await settleJob(client, job, outcome === "blocked" ? "cancelled" : "completed", reason, at);
          return evaluationId;
        };
        if (!authorized || !trigger || job.purpose !== "assessment" || context.chatId !== job.chatId || context.triggerMessageId !== job.messageId
          || context.policy.chatId !== job.chatId || !context.policy.enabled || context.policy.version !== job.policyVersion) {
          await finish("blocked", "policy_or_trigger_invalid"); return "blocked";
        }
        if (!sourcesValid || !group || Number(group.context_version) !== context.contextVersion || Number(group.catalog_version) !== context.catalogVersion) {
          await requeueOwnedJob(client, job, at, JSON.stringify({ reason: "context_stale",
            sourceProtectionValid: sourcesValid,
            expectedContext: context.contextVersion, currentContext: group?.context_version,
            expectedCatalog: context.catalogVersion, currentCatalog: group?.catalog_version }));
          return "stale";
        }
        if (issues.length > 100 || (issues.length === 100 && assessment.issueRef?.kind === "new")) {
          await finish("blocked", "catalog_capacity_degraded"); return "blocked";
        }
        if (assessment.issueRef?.kind === "new" && issues.some(issue => !context.issues.some(supplied => supplied.id === issue.id))) {
          await finish("blocked", "incomplete_catalog"); return "blocked";
        }
        const issueId = assessment.issueRef?.kind === "existing" ? assessment.issueRef.id : undefined;
        const issue = issues.find(item => item.id === issueId);
        const supplied = context.issues.find(item => item.id === issueId);
        if (issueId && (!issue || !supplied || issue.version !== supplied.version || issue.basisVersion !== supplied.basisVersion)) {
          await requeueOwnedJob(client, job, at, "issue_version_stale"); return "stale";
        }
        try {
          if (context.sources.some(source => source.ref !== createPdSourceRef(source))
            || context.items.some(item => !context.sources.some(source => source.ref === item.ref))) throw new Error("invalid source");
          validatePdAssessment(assessment, { ...context, issues: issues.filter(item => context.issues.some(s => s.id === item.id)) });
          if (assessment.decision === "intervene" && (draft === null || !draft.text.trim() || draft.text.length > 1200
            || new Set(draft.evidenceRefs).size !== assessment.evidenceRefs.length
            || draft.evidenceRefs.length !== assessment.evidenceRefs.length
            || draft.evidenceRefs.some(ref => !assessment.evidenceRefs.includes(ref)))) throw new Error("invalid draft");
          if (assessment.decision === "skip" && draft !== null) throw new Error("skip draft");
          if (assessment.reason === "resolved" && (!issue || issue.state === "user_paused")) throw new Error("invalid resolution");
        } catch {
          await finish("blocked", "assessment_or_draft_invalid"); return "blocked";
        }
        if (assessment.decision === "skip") {
          if (assessment.reason === "resolved" && issue && issue.state !== "resolved") {
            await client.query(`UPDATE proactive_discussion_issues SET state='resolved',version=version+1,updated_at=$2 WHERE id=$1`, [issue.id, at]);
            await advanceCatalog(client, job.chatId, at);
            await cancelPrepared(client, issue.id, "issue_resolved", at);
          }
          await finish("skipped", assessment.reason); return "skipped";
        }
        if (issue && !await hasUnconsumedIssueEvidence(client, issue,
          context.sources.filter(source => assessment.materialChange.evidenceRefs.includes(source.ref)))) {
          await finish("blocked", "issue_evidence_already_consumed"); return "blocked";
        }
        const id = issue?.id ?? randomUUID();
        const version = (issue?.version ?? 0) + 1;
        const basis = (issue?.basisVersion ?? 0) + 1;
        const basisSources = context.sources.filter(source => assessment.evidenceRefs.includes(source.ref));
        if (issue) {
          await client.query(`UPDATE proactive_discussion_issues SET state='observing',version=$2,basis_version=$3,
            last_observation=$4,last_reasoning=$5,last_suggestion=$6,basis_sources=$7::jsonb,updated_at=$8 WHERE id=$1`,
          [id, version, basis, assessment.observation, assessment.reasoning, assessment.suggestion, JSON.stringify(basisSources), at]);
          await cancelPrepared(client, id, "basis_superseded", at);
        } else {
          await client.query(`INSERT INTO proactive_discussion_issues
            (id,chat_id,description,state,version,basis_version,last_observation,last_reasoning,last_suggestion,basis_sources,created_at,updated_at)
            VALUES($1,$2,$3,'observing',1,1,$4,$5,$6,$7::jsonb,$8,$8)`,
          [id, job.chatId, assessment.issueRef!.kind === "new" ? assessment.issueRef!.description : "",
            assessment.observation, assessment.reasoning, assessment.suggestion, JSON.stringify(basisSources), at]);
        }
        await advanceCatalog(client, job.chatId, at);
        const evaluationId = await finish("prepared", null);
        const deliveryId = randomUUID();
        // The delivery INSERT audit event captures the real policy authorization.
        await client.query(`INSERT INTO proactive_discussion_deliveries
          (id,chat_id,issue_id,evaluation_id,issue_version,basis_version,policy_version,context_version,trigger_message_id,text,reply_uuid,authorization_kind,created_at,updated_at)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'policy',$12,$12)`,
        [deliveryId, job.chatId, id, evaluationId, version, basis, job.policyVersion, context.contextVersion,
          job.messageId, draft!.text, "pd-" + createHash("sha256").update(deliveryId).digest("hex").slice(0, 40), at]);
        await appendSources(client, "delivery_id", deliveryId, context.sources);
        return "prepared";
      });
    },
    async requeueEvaluation({ job, at }) {
      date(at);
      await transaction(dataSource, async client => {
        const authorized = await lockPolicyRuntime(client, job);
        const { trigger } = await lockMessages(client, job, []);
        if (!await lockOwnedJob(client, job, at)) return;
        if (!authorized || !trigger) { await settleJob(client, job, "cancelled", "policy_or_trigger_invalid", at); return; }
        await requeueOwnedJob(client, job, at, "context_unavailable");
      });
    },
    async applyFeedback({ job, action, issueId, expectedIssueVersion, actorOpenId, verifiedMessage, verifiedReplyMessageId, at }) {
      date(at); safeInteger(expectedIssueVersion, 1);
      return transaction(dataSource, async client => {
        const authorized = await lockPolicyRuntime(client, job);
        const { trigger } = await lockMessages(client, job, []);
        await client.query("SELECT chat_id FROM proactive_discussion_groups WHERE chat_id=$1 FOR UPDATE", [job.chatId]);
        const issueRow = (await client.query(`${issueSelect} WHERE i.id=$1 AND i.chat_id=$2 FOR UPDATE OF i`, [issueId, job.chatId])).rows[0];
        const receipt = (await client.query(`SELECT id FROM proactive_discussion_deliveries
          WHERE chat_id=$1 AND issue_id=$2 AND state='sent' AND reply_message_id=$3`, [job.chatId, issueId, verifiedReplyMessageId])).rows;
        const row = (await client.query("SELECT * FROM proactive_discussion_jobs WHERE id=$1 FOR UPDATE", [job.id])).rows[0];
        // JSONB key order is independent of the caller's property insertion order.
        const feedback = row?.feedback as PdJob["feedback"];
        const proofMatches = feedback && job.feedback && feedback.action === action && job.feedback.action === action
          && feedback.replyMessageId === verifiedReplyMessageId && job.feedback.replyMessageId === verifiedReplyMessageId
          && feedback.actorOpenId === actorOpenId && job.feedback.actorOpenId === actorOpenId
          && feedback.irisMentionKey === job.feedback.irisMentionKey
          && job.purpose === "feedback" && trigger?.sender_open_id === actorOpenId
          && verifiedMessage.chatId === job.chatId && verifiedMessage.messageId === job.messageId
          && verifiedMessage.contentHash === job.contentHash && typeof trigger.text === "string"
          && parsePdFeedback(removePdFeedbackMention(trigger.text, feedback.irisMentionKey)) === action;
        if (row?.state === "completed" && row.last_error === "feedback_applied" && proofMatches && receipt.length === 1) return "duplicate";
        if (!await lockOwnedJob(client, job, at)) return "blocked";
        if (!authorized || !proofMatches || !issueRow || receipt.length !== 1
          || safeInteger(issueRow.version, 1) !== expectedIssueVersion) {
          await settleJob(client, job, "cancelled", "feedback_blocked", at); return "blocked";
        }
        const issue = decodeIssue(issueRow);
        const next = action === "pause" ? "user_paused" : "observing";
        if (action === "resume" && issue.state !== "user_paused") {
          await settleJob(client, job, "completed", "feedback_no_change", at); return "duplicate";
        }
        if (issue.state !== next) {
          await client.query(`UPDATE proactive_discussion_issues SET state=$2,version=version+1,updated_at=$3 WHERE id=$1`, [issueId, next, at]);
          await advanceCatalog(client, job.chatId, at);
        }
        // Both pause and resume invalidate any old pending advice. Resume waits
        // for a future message with a materially new basis before preparing again.
        await cancelPrepared(client, issueId, action === "pause" ? "user_paused" : "user_resumed", at);
        await settleJob(client, job, "completed", "feedback_applied", at);
        return "applied";
      });
    },
    async findIssueByReply({ chatId, replyMessageId }) {
      const rows = (await dataSource.query(`${issueSelect} WHERE i.chat_id=$1 AND EXISTS
        (SELECT 1 FROM proactive_discussion_deliveries d WHERE d.issue_id=i.id AND d.chat_id=i.chat_id
          AND d.state='sent' AND d.reply_message_id=$2) ORDER BY i.id LIMIT 2`, [chatId, replyMessageId])).rows;
      return rows.length === 1 ? decodeIssue(rows[0]!) : null;
    },
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
      if (input.feedback?.irisMentionKey !== undefined && !isIdentifier(input.feedback.irisMentionKey, 512)) return "blocked";
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
          || (input.feedback && (message.sender_open_id !== input.feedback.actorOpenId
            || parsePdFeedback(removePdFeedbackMention(message.text, input.feedback.irisMentionKey)) !== input.feedback.action
            || (input.feedback.irisMentionKey !== undefined && removePdFeedbackMention(message.text, input.feedback.irisMentionKey) === message.text)))) return "blocked";
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
        const issueRows = await client.query(`${issueSelect} WHERE i.chat_id=$1 ORDER BY i.id LIMIT 101`, [chatId]);
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
      const feedbackBlocked = job.purpose === "feedback" && !retryable && reason === "feedback_blocked";
      const availableAt = new Date(at.getTime() + (job.attempt === 1 ? 1000 : 5000));
      date(availableAt);
      await transaction(dataSource, async client => {
        await client.query(`UPDATE proactive_discussion_jobs SET state=$6,version=version+1,
          lease_token=NULL,lease_until=NULL,worker_id=NULL,last_error=$7,available_at=$8,updated_at=$9
          WHERE id=$1 AND chat_id=$2 AND policy_version=$3 AND lease_token=$4 AND attempts=$5
            AND state='processing' AND lease_until > $9`,
        [job.id, job.chatId, job.policyVersion, job.leaseToken, job.attempt,
          feedbackBlocked ? "cancelled" : terminal ? "dead_letter" : "retry", String(reason).slice(0, 2000), availableAt, at]);
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

const issueSelect = `SELECT i.*, EXISTS (SELECT 1 FROM proactive_discussion_deliveries d
  WHERE d.issue_id=i.id AND d.state IN ('sending','outcome_unknown')) AS unknown_delivery FROM proactive_discussion_issues i`;

async function hasUnconsumedIssueEvidence(client: TransactionClient, issue: PdIssue, candidates: PdSource[]): Promise<boolean> {
  // Current basis prose stays bounded to its actual premises. Novelty also checks
  // immutable earlier prepared assessments, including cancelled/resolved bases.
  // Merely exposing a source to the model did not consume it as issue evidence.
  const result = await client.query(`SELECT EXISTS (
    SELECT 1 FROM jsonb_array_elements($3::jsonb) candidate WHERE NOT EXISTS (
      SELECT 1 FROM proactive_discussion_deliveries d
      JOIN proactive_discussion_evaluations e ON e.id=d.evaluation_id AND e.chat_id=d.chat_id
      JOIN proactive_discussion_sources s ON s.evaluation_id=e.id
      WHERE d.chat_id=$1 AND d.issue_id=$2 AND e.outcome='prepared'
        AND (e.assessment->'evidenceRefs') ? s.ref
        AND s.kind=candidate->>'kind' AND s.binding=candidate->'binding'
    )) AS has_unconsumed`, [issue.chatId, issue.id, JSON.stringify(candidates)]);
  return result.rows[0]?.has_unconsumed === true;
}

async function readRuntime(client: TransactionClient, lock: boolean) {
  const row = (await client.query(`SELECT revision,desired_global_enabled,disabled_group_ids,capabilities,updated_at,updated_by
    FROM runtime_control_state WHERE singleton_id=1${lock ? " FOR SHARE" : ""}`)).rows[0];
  return row ? decodeDurableRuntimeControlSnapshot(row) : null;
}

async function lockPolicyRuntime(client: TransactionClient, job: Pick<PdJob, "chatId" | "policyVersion">,
  checkedRuntimeRevision?: number): Promise<boolean> {
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`iris:proactive-discussion:policy:${job.chatId}`]);
  const policy = (await client.query(`SELECT version,enabled FROM proactive_discussion_policies WHERE chat_id=$1 FOR SHARE`, [job.chatId])).rows[0];
  const runtime = await readRuntime(client, true);
  if (!runtime) return false;
  if (arguments.length >= 3 && (!Number.isSafeInteger(checkedRuntimeRevision) || checkedRuntimeRevision !== runtime.revision)) return false;
  return job.chatId === PD_PILOT_CHAT && policy?.enabled === true && Number(policy.version) === job.policyVersion
    && runtime.desiredGlobalEnabled && !runtime.disabledGroupIds.includes(job.chatId)
    && runtime.capabilities.readGroupContext && runtime.capabilities.proactiveSpeech;
}

async function lockMessages(client: TransactionClient, job: Pick<PdJob, "chatId" | "messageId" | "contentHash">, sources: PdSource[]): Promise<{
  trigger: Row | null; sourcesValid: boolean;
}> {
  const bindings = sources.filter(source => source.kind === "message");
  const ids = [...new Set([job.messageId, ...bindings.map(source => source.binding.messageId)])].sort();
  for (const id of ids) await lockConversationMessageIngestScope({ queryable: client, conversationMessageId: `feishu:${id}` });
  const rows = (await client.query(`SELECT m.id,m.provider,m.provider_message_id,m.chat_id,m.text,m.sender_open_id
    FROM conversation_messages m WHERE (m.provider='feishu' AND m.provider_message_id=ANY($1::text[]))
      OR m.id=ANY($2::text[])`, [ids, ids.map(id => `feishu:${id}`)])).rows;
  const deleted = new Set((await client.query(`SELECT provider_message_id FROM conversation_message_deletion_tombstones
    WHERE provider='feishu' AND provider_message_id=ANY($1::text[])`, [ids])).rows.map(row => row.provider_message_id));
  const rowsFor = (id: string) => rows.filter(row => row.provider_message_id === id || row.id === `feishu:${id}`);
  const validIdentity = (row: Row, id: string) => row.id === `feishu:${id}` && row.provider === "feishu"
    && row.provider_message_id === id && row.chat_id === job.chatId;
  const triggerRows = rowsFor(job.messageId);
  const trigger = triggerRows.length === 1 ? triggerRows[0] : undefined;
  // Only the registered trigger requires a durable event row. Other sources can
  // be freshly verified history-only messages; never backfill them as events.
  // All IDs share deletion protection, and any existing row must still match.
  // Local edits/deletes also invalidate the group context CAS. Full live hashes
  // remain the context builder's transaction-external contract (stored text may
  // be truncated and must not be compared with a full live source hash).
  return {
    trigger: trigger && validIdentity(trigger, job.messageId) && !deleted.has(job.messageId)
      && typeof trigger.text === "string" && hashLocalMessageText(trigger.text) === job.contentHash ? trigger : null,
    sourcesValid: bindings.every(source => source.binding.chatId === job.chatId && !deleted.has(source.binding.messageId)
      && rowsFor(source.binding.messageId).every(row => validIdentity(row, source.binding.messageId))),
  };
}

async function lockDeliveryDocuments(client: TransactionClient, sources: PdSource[], chatId: string): Promise<boolean> {
  const bindings: AnswerDocumentSourceLockBinding[] = sources.flatMap(source => source.kind !== "document" ? [] : [{
    documentSourceId: source.binding.documentSourceId, documentSnapshotId: source.binding.documentSnapshotId,
    ...(source.binding.crossGroupGrantId === undefined ? {} : { crossGroupGrantId: source.binding.crossGroupGrantId }),
    ...(source.binding.crossGroupGrantVersion === undefined ? {} : { crossGroupGrantVersion: source.binding.crossGroupGrantVersion }),
    ...(source.binding.crossGroupGrantorGroupId === undefined ? {} : { crossGroupGrantorGroupId: source.binding.crossGroupGrantorGroupId }),
    ...(source.binding.crossGroupGranteeGroupId === undefined ? {} : { crossGroupGranteeGroupId: source.binding.crossGroupGranteeGroupId }),
  }]);
  if (bindings.length === 0) return true;
  // Acquire the stronger ordinary-source lock before grants. Grant writers lock
  // source FOR UPDATE before grant rows, so upgrading after grants can deadlock.
  const ids = [...new Set(bindings.map(source => source.documentSourceId))].sort();
  await acquireManagedKnowledgeSourceLocks(client, ids);
  // FOR UPDATE also blocks the FK KEY SHARE taken by new snapshot inserts.
  const rows = (await client.query(`SELECT * FROM document_sources WHERE id=ANY($1::text[]) ORDER BY id FOR UPDATE`, [ids])).rows;
  if (rows.length !== ids.length) return false;
  for (const binding of bindings) {
    const row = rows.find(source => source.id === binding.documentSourceId)!;
    if (row.permission_state !== "readable" || row.sync_state !== "synced" || row.can_use_for_answering !== true) return false;
    if (binding.crossGroupGrantId === undefined && row.source_type === "group_visible_document"
      && row.origin_group_id !== chatId && !(await client.query(`SELECT id FROM document_source_evidence
        WHERE document_source_id=$1 AND kind='group_message' AND group_id=$2 LIMIT 1`, [row.id, chatId])).rows.length) return false;
    const snapshot = (await client.query(`SELECT id FROM document_snapshots WHERE document_source_id=$1
      AND fetch_status='succeeded' ORDER BY fetched_at DESC,id ASC LIMIT 1 FOR SHARE`, [row.id])).rows[0];
    if (snapshot?.id !== binding.documentSnapshotId) return false;
  }
  try { await lockAnswerDocumentSources({ client, sources: bindings, chatId }); }
  catch (error) { if (error instanceof AnswerReplyGrantStaleError) return false; throw error; }
  return true;
}

async function deliverySources(client: TransactionClient, id: string): Promise<PdSource[]> {
  return (await client.query(`SELECT kind,ref,binding FROM proactive_discussion_sources
    WHERE delivery_id=$1 ORDER BY source_index`, [id])).rows.map(row => {
    const source = row as PdSource;
    if (source.ref !== createPdSourceRef(source)) throw new Error("invalid durable proactive source");
    return source;
  });
}

async function lockDeliveryParents(client: TransactionClient, deliveryId: string): Promise<void> {
  const row = (await client.query("SELECT chat_id,issue_id FROM proactive_discussion_deliveries WHERE id=$1", [deliveryId])).rows[0];
  if (!row) return;
  await client.query("SELECT chat_id FROM proactive_discussion_groups WHERE chat_id=$1 FOR UPDATE", [row.chat_id]);
  await client.query("SELECT id FROM proactive_discussion_issues WHERE id=$1 FOR UPDATE", [row.issue_id]);
}

async function cancelOwnedDelivery(client: TransactionClient, delivery: PdDelivery, reason: string, at: Date, requeue: boolean) {
  const row = (await client.query(`UPDATE proactive_discussion_deliveries SET state='cancelled',version=version+1,
    lease_token=NULL,lease_until=NULL,worker_id=NULL,last_error=$3,updated_at=$4
    WHERE id=$1 AND lease_token=$2 AND state='prepared' AND attempted_at IS NULL RETURNING evaluation_id`,
  [delivery.id, delivery.leaseToken, reason, at])).rows[0];
  if (row && requeue) {
    // Reuse the existing trigger job. Its next claim advances the attempt, so the
    // immutable prior evaluation and consumed evidence history stay intact.
    await client.query(`UPDATE proactive_discussion_jobs SET state='pending',version=version+1,
      available_at=$2,last_error='delivery_context_stale',updated_at=$2 WHERE state='completed' AND id IN
      (SELECT job_id FROM proactive_discussion_evaluations WHERE id=$1)`, [row.evaluation_id, at]);
  }
}

function decodeDelivery(row: Row, sources: PdSource[]): PdDelivery {
  if (!["prepared", "sending", "sent", "cancelled", "outcome_unknown"].includes(String(row.state))) throw new Error("invalid delivery state");
  return { id: identifier(row.id, 512), chatId: identifier(row.chat_id, 512), issueId: identifier(row.issue_id, 512),
    issueVersion: safeInteger(row.issue_version, 1), basisVersion: safeInteger(row.basis_version, 1),
    policyVersion: safeInteger(row.policy_version, 1), contextVersion: safeInteger(row.context_version, 1),
    triggerMessageId: identifier(row.trigger_message_id, 505), text: String(row.text), sources,
    uuid: identifier(row.reply_uuid, 128), state: row.state as PdDelivery["state"], leaseToken: row.lease_token === null ? "" : identifier(row.lease_token, 512) };
}

function sameDelivery(left: PdDelivery, right: PdDelivery): boolean {
  return left.id === right.id && left.chatId === right.chatId && left.issueId === right.issueId
    && left.issueVersion === right.issueVersion && left.basisVersion === right.basisVersion
    && left.policyVersion === right.policyVersion && left.contextVersion === right.contextVersion
    && left.triggerMessageId === right.triggerMessageId && left.text === right.text && left.uuid === right.uuid
    && left.sources.length === right.sources.length && left.sources.every((source, index) => source.ref === right.sources[index]?.ref
      && source.ref === createPdSourceRef(source));
}

async function lockOwnedJob(client: TransactionClient, job: PdJob, at: Date): Promise<Row | null> {
  return (await client.query(`SELECT * FROM proactive_discussion_jobs WHERE id=$1 AND chat_id=$2
    AND message_id=$3 AND content_hash=$4 AND policy_version=$5 AND lease_token=$6 AND attempts=$7 AND purpose=$8
    AND state='processing' AND lease_until>$9 FOR UPDATE`,
  [job.id, job.chatId, job.messageId, job.contentHash, job.policyVersion, job.leaseToken, job.attempt, job.purpose, at])).rows[0] ?? null;
}

async function settleJob(client: TransactionClient, job: PdJob, state: "cancelled" | "completed", reason: string | null, at: Date): Promise<void> {
  await client.query(`UPDATE proactive_discussion_jobs SET state=$2,version=version+1,
    lease_token=NULL,lease_until=NULL,worker_id=NULL,last_error=$3,updated_at=$4 WHERE id=$1`, [job.id, state, reason, at]);
}

async function requeueOwnedJob(client: TransactionClient, job: PdJob, at: Date, reason: string): Promise<void> {
  // A context conflict did not consume a technical attempt. The immutable job
  // event retains it; terminal evaluations alone occupy UNIQUE(job_id,attempt).
  await client.query(`UPDATE proactive_discussion_jobs SET state='pending',version=version+1,
    lease_token=NULL,lease_until=NULL,worker_id=NULL,attempts=attempts-1,last_error=$2,available_at=$3,updated_at=$3 WHERE id=$1`,
  [job.id, reason, at]);
}

async function appendSources(client: TransactionClient, column: "evaluation_id" | "delivery_id", id: string, sources: PdSource[]): Promise<void> {
  for (const [index, source] of sources.entries()) {
    await client.query(`INSERT INTO proactive_discussion_sources(${column},source_index,kind,ref,binding)
      VALUES($1,$2,$3,$4,$5::jsonb)`, [id, index, source.kind, source.ref, JSON.stringify(source.binding)]);
  }
}

async function advanceCatalog(client: TransactionClient, chatId: string, at: Date): Promise<void> {
  await client.query("UPDATE proactive_discussion_groups SET catalog_version=catalog_version+1,updated_at=$2 WHERE chat_id=$1", [chatId, at]);
}

async function cancelPrepared(client: TransactionClient, issueId: string, reason: string, at: Date): Promise<void> {
  await client.query(`UPDATE proactive_discussion_deliveries SET state='cancelled',version=version+1,
    lease_token=NULL,lease_until=NULL,worker_id=NULL,last_error=$2,updated_at=$3 WHERE issue_id=$1 AND state='prepared'`, [issueId, reason, at]);
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
