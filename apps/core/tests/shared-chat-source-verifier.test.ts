import { describe, expect, it } from "vitest";
import { createSharedChatSourceVerifier } from "../src/shared-chat/shared-chat-source-verifier.js";
import { hashSharedChatText, type SharedChatSourceBinding } from "../src/shared-chat/working-chat-scope.js";

function fixture() {
  const bodies = new Map(Array.from({ length: 9 }, (_, index) => [`message-${index}`, `original-${index}`]));
  const sources: SharedChatSourceBinding[] = [...bodies].map(([messageId, text]) => ({ scopeId: "pilot-working-chat",
    scopeVersion: 1, sourceChatId: "group-a", destinationChatId: "group-b", messageId, contentHash: hashSharedChatText(text) }));
  const deniedBots = new Set<string>();
  const disabledGroups = new Set<string>();
  const deleted = new Set<string>();
  let scopeVersion = 1;
  let readable = true;
  let replyEnabled = true;
  const verifier = createSharedChatSourceVerifier({
    scopes: { async validateExact(source) { return source.scopeVersion === scopeVersion && !deleted.has(source.messageId); } },
    runtimeController: { canReadGroupContext: chatId => readable && !disabledGroups.has(chatId),
      canReplyWhenMentioned: chatId => replyEnabled && !disabledGroups.has(chatId) },
    botAccessChecker: { async canAccessChat({ chatId }) { return !deniedBots.has(chatId); } },
    reader: { async listRecentMessages() { throw new Error("exact proof cannot use a recent list"); },
      async readMessagesByIds({ chatId, messageIds }) {
        return messageIds.slice(0, 8).flatMap(messageId => bodies.has(messageId) ? [{ messageId, chatId,
          text: bodies.get(messageId)!, senderId: "human", sentAt: new Date("2026-09-09T00:00:00Z") }] : []);
      } },
  });
  return { verifier, sources, bodies, deniedBots, disabledGroups, deleted,
    revoke: () => { scopeVersion += 1; }, disableReading: () => { readable = false; }, disableReply: () => { replyEnabled = false; } };
}

describe("fresh shared chat source proof", () => {
  it("verifies all nine originals despite the reader's eight-ID maximum", async () => {
    const f = fixture();
    expect(await f.verifier.verify({ chatId: "group-b", sources: f.sources })).toBe(true);
    f.bodies.delete("message-8");
    expect(await f.verifier.verify({ chatId: "group-b", sources: f.sources })).toBe(false);
  });
  it("rejects a body changed before the final probe", async () => {
    const f = fixture();
    f.bodies.set("message-0", "changed original");
    expect(await f.verifier.verify({ chatId: "group-b", sources: f.sources })).toBe(false);
  });
  it.each(["group-a", "group-b"])("rejects a disabled %s", async groupId => {
    const f = fixture(); f.disabledGroups.add(groupId);
    expect(await f.verifier.verify({ chatId: "group-b", sources: f.sources })).toBe(false);
  });
  it.each(["group-a", "group-b"])("rejects lost bot access in %s", async groupId => {
    const f = fixture(); f.deniedBots.add(groupId);
    expect(await f.verifier.verify({ chatId: "group-b", sources: f.sources })).toBe(false);
  });
  it.each(["revoke", "disableReading", "disableReply"] as const)("fails closed after %s", async action => {
    const f = fixture(); f[action]();
    expect(await f.verifier.verify({ chatId: "group-b", sources: f.sources })).toBe(false);
  });
  it("rejects local tombstones and a substituted destination", async () => {
    const f = fixture(); f.deleted.add("message-8");
    expect(await f.verifier.verify({ chatId: "group-b", sources: f.sources })).toBe(false);
    expect(await fixture().verifier.verify({ chatId: "group-c", sources: f.sources })).toBe(false);
  });
});
