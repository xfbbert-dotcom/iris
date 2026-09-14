import { createHash } from "node:crypto";
import type { FeishuChatHistoryReader } from "../feishu/feishu-chat-history-reader.js";
import type { FeishuMessageReplier } from "../feishu/feishu-message-replier.js";
import type { PdClaimedDelivery, PdRepository } from "./repository.js";
import type { PdSourceVerifier } from "./source-verifier.js";
import { hashLocalMessageText } from "../memory/local-message-source.js";

export function createPdDeliveryWorker({ repository, sourceVerifier, reader, replier, now, workerId, isStopping = () => false }: {
  repository: PdRepository; sourceVerifier: PdSourceVerifier; reader: FeishuChatHistoryReader;
  replier: FeishuMessageReplier; now: () => Date; workerId: string;
  isStopping?: () => boolean;
}): { runOnce(): Promise<"idle" | "processed" | "failed"> } {
  return {
    async runOnce() {
      let delivery: PdClaimedDelivery | null = null;
      let declared = false;
      let receiptRecorded = false;
      try {
        if (isStopping()) return "idle";
        const at = now();
        delivery = await repository.claimDelivery({ workerId, at, leaseUntil: new Date(at.getTime() + 60_000) });
        if (!delivery) return "idle";
        if (isStopping()) throw new Error("runtime stopping");
        const state = await repository.readState(delivery.chatId);
        if (isStopping()) throw new Error("runtime stopping");
        if (state.contextVersion !== delivery.contextVersion
          || !await sourceVerifier.verify({ chatId: delivery.chatId, sources: delivery.sources })
          || isStopping() || !await currentWindowMatches(delivery)) {
          await repository.cancelDelivery({ delivery, reason: "context_stale", at: now() });
          return "processed";
        }
        if (isStopping()) throw new Error("runtime stopping");
        if (await repository.beginSend({ delivery, checkedContextVersion: state.contextVersion, at: now() }) !== "sending") return "processed";
        declared = true;
        if (isStopping()) throw new Error("runtime stopping");
        // Exactly one invocation after the durable declaration. A missing receipt
        // or uncertain database response can never restore a prepared delivery.
        const uuid = "pd-" + createHash("sha256").update(delivery.id).digest("hex").slice(0, 40);
        const result = await replier.replyText({ messageId: delivery.triggerMessageId, text: delivery.text, uuid, replyInThread: false });
        const replyMessageId = result.replyMessageId;
        const hasReceipt = typeof replyMessageId === "string" && replyMessageId.trim() === replyMessageId
          && replyMessageId.length > 0 && replyMessageId.length <= 505;
        await repository.finishSend({ delivery, outcome: hasReceipt ? "sent" : "outcome_unknown",
          ...(hasReceipt ? { replyMessageId } : { reason: "missing_reply_receipt" }), at: now() });
        receiptRecorded = true;
        return "processed";
      } catch {
        if (delivery && !declared) await repository.cancelDelivery({ delivery, reason: "pre_send_check_failed", at: now() }).catch(() => undefined);
        return "failed";
      } finally {
        if (delivery && declared && !receiptRecorded) {
          // If this write also fails, durable sending blocks the issue. Lease
          // recovery marks it unknown without invoking the remote replier again.
          await repository.finishSend({ delivery, outcome: "outcome_unknown", reason: "send_or_receipt_failed", at: now() }).catch(() => undefined);
        }
      }
    },
  };

  async function currentWindowMatches(delivery: PdClaimedDelivery): Promise<boolean> {
    const messages = await reader.listRecentMessages({ chatId: delivery.chatId, limit: 20 });
    const saved = delivery.sources.filter(source => source.kind === "message");
    // The saved source union also contains older issue premises. Containment is
    // intentionally conservative; every saved source was freshly verified above,
    // while every eligible recent item must belong to the saved full-body set.
    return messages.filter(message => message.chatId === delivery.chatId && message.role !== "assistant"
      && message.senderId.trim().length > 0 && message.text.trim().length > 0 && message.sharedChatRecap !== true
      && message.underlyingDocumentSources === undefined && message.underlyingChatSources === undefined
      && !("sharedChatSource" in message)).every(message => saved.some(source => source.binding.chatId === delivery.chatId
        && source.binding.messageId === message.messageId && source.binding.contentHash === hashLocalMessageText(message.text)));
  }
}
