import type { PdEvaluationRepository } from "./repository.js";
import type { PdContextBuilder } from "./context-builder.js";
import type { PdModel } from "./model.js";
import type { FeishuGroupMembershipChecker } from "../feishu/feishu-group-membership-checker.js";
import type { FeishuChatHistoryReader } from "../feishu/feishu-chat-history-reader.js";
import { normalizeConversationMessageTextForStorage } from "../conversation/conversation-message-repository.js";
import { hashLocalMessageText } from "../memory/local-message-source.js";
import { parsePdFeedback, removePdFeedbackMention } from "./feedback.js";
import type { PdJob } from "./contracts.js";

export function createPdEvaluationWorker({ repository, contextBuilder, model, membership, reader, now, workerId }: {
  repository: PdEvaluationRepository; contextBuilder: PdContextBuilder; model: PdModel;
  membership: Pick<FeishuGroupMembershipChecker, "isCurrentMember">;
  reader: FeishuChatHistoryReader; now: () => Date; workerId: string;
}): { runOnce(): Promise<"idle" | "processed" | "failed"> } {
  return {
    async runOnce() {
      let job: PdJob | null = null;
      try {
        const at = now();
        job = await repository.claimEvaluation({ workerId, at, leaseUntil: new Date(at.getTime() + 60_000) });
        if (job === null) return "idle";
        if (job.purpose === "feedback") {
          const feedbackJob = job;
          const block = async () => {
            await repository.failEvaluation({ job: feedbackJob, reason: "feedback_blocked", retryable: false, at: now() });
            return "processed" as const;
          };
          if (!job.feedback || !reader.readMessagesByIds) return await block();
          const messages = await reader.readMessagesByIds({ chatId: job.chatId, messageIds: [job.messageId], sender: "user" });
          const message = messages.length === 1 ? messages[0] : undefined;
          const storedText = message && normalizeConversationMessageTextForStorage(message.text);
          if (!message || message.messageId !== job.messageId || message.chatId !== job.chatId
            || message.senderId !== job.feedback.actorOpenId || message.role === "assistant"
            || message.sharedChatRecap || message.underlyingDocumentSources || message.underlyingChatSources
            || storedText == null || hashLocalMessageText(storedText) !== job.contentHash
            || (message.parentMessageId ?? message.rootMessageId) !== job.feedback.replyMessageId
            || parsePdFeedback(removePdFeedbackMention(message.text, job.feedback.irisMentionKey)) !== job.feedback.action) return await block();
          const issue = await repository.findIssueByReply({ chatId: job.chatId, replyMessageId: job.feedback.replyMessageId });
          if (!issue || issue.chatId !== job.chatId) return await block();
          if (!await membership.isCurrentMember({ chatId: job.chatId, openId: job.feedback.actorOpenId })) return await block();
          await repository.applyFeedback({ job, action: job.feedback.action, issueId: issue.id, expectedIssueVersion: issue.version,
            actorOpenId: job.feedback.actorOpenId, verifiedReplyMessageId: job.feedback.replyMessageId,
            verifiedMessage: { chatId: job.chatId, messageId: message.messageId, contentHash: hashLocalMessageText(message.text) }, at: now() });
          return "processed";
        }
        const context = await contextBuilder.load(job);
        if (context === null) { await repository.requeueEvaluation({ job, at: now() }); return "processed"; }
        const assessment = await model.assess(context);
        const draft = assessment.decision === "intervene" ? await model.render({ context, assessment }) : null;
        await repository.commitEvaluation({ job, context, assessment, draft, at: now() });
        return "processed";
      } catch {
        // If persistence itself failed, the durable lease remains recoverable;
        // the worker outcome still tells the runtime this run failed.
        if (job !== null) {
          try { await repository.failEvaluation({ job, reason: "evaluation_failed", retryable: true, at: now() }); }
          catch { /* The expired-lease path owns recovery. */ }
        }
        return "failed";
      }
    },
  };
}
