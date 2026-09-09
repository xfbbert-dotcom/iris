import { describe, expect, it } from "vitest";
import {
  hashSharedChatText,
  normalizeSharedChatSourceBinding,
  normalizeWorkingChatScopeReplacement,
} from "../src/shared-chat/working-chat-scope.js";

const at = new Date("2026-09-09T00:00:00Z");
const groups = [{ chatId: "group-a", name: "A" }, { chatId: "group-b", name: "B" }];
const replacement = { expectedVersion: 0, state: "active" as const, groups, updatedBy: "operator", at };
const binding = { scopeId: "pilot-working-chat", scopeVersion: 1, sourceChatId: "group-a",
  destinationChatId: "group-b", messageId: "message-1", contentHash: "a".repeat(64) };

describe("working chat scope contracts", () => {
  it("normalizes metadata deterministically without retaining mutable caller values", () => {
    const input = { ...replacement, groups: [{ chatId: " group-b ", name: " B " }, groups[0]!],
      updatedBy: " operator ", at: new Date(at) };
    const result = normalizeWorkingChatScopeReplacement(input);
    expect(result).toEqual(replacement);
    input.groups[0]!.name = "changed";
    input.at.setUTCFullYear(2030);
    expect(result.groups).toEqual(groups);
    expect(result.at).toEqual(at);
  });

  it.each([
    { groups: [] }, { groups: [groups[0]] },
    { groups: Array.from({ length: 6 }, (_, index) => ({ chatId: `group-${index}`, name: "group" })) },
    { groups: [groups[0], { chatId: " group-a ", name: "duplicate" }] },
    { groups: [groups[0], undefined] }, { groups: [groups[0], , groups[1]] },
    { groups: [groups[0], { chatId: "x".repeat(513), name: "B" }] },
    { groups: [groups[0], { chatId: "group-b", name: "x".repeat(257) }] },
    { groups: [groups[0], { chatId: "group-b", name: " " }] },
    { updatedBy: " " }, { updatedBy: "x".repeat(257) },
    { expectedVersion: -1 }, { expectedVersion: 0.5 }, { expectedVersion: "0" },
    { expectedVersion: Number.MAX_SAFE_INTEGER }, { state: "enabled" },
    { at: new Date("invalid") }, { at: "2026-09-09T00:00:00Z" },
  ])("rejects malformed scope replacement %# before persistence", (invalid) => {
    expect(() => normalizeWorkingChatScopeReplacement({ ...replacement, ...invalid } as never)).toThrow();
  });

  it.each([
    { scopeId: "other-scope" }, { scopeVersion: 0 }, { scopeVersion: 1.5 },
    { sourceChatId: "group-b" }, { destinationChatId: " " },
    { messageId: " " }, { messageId: "x".repeat(506) },
    { contentHash: "a" }, { contentHash: "A".repeat(64) },
  ])("rejects unbounded or ambiguous source binding %#", (invalid) => {
    expect(() => normalizeSharedChatSourceBinding({ ...binding, ...invalid })).toThrow();
  });

  it("retains the exact version and original message identity", () => {
    expect(normalizeSharedChatSourceBinding(binding)).toEqual(binding);
  });

  it("hashes trimmed human text with stable CRLF normalization", () => {
    expect(hashSharedChatText("  hello\r\n")).toBe("2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824");
    expect(hashSharedChatText("hello\r\nworld")).toBe(hashSharedChatText("hello\nworld"));
    expect(hashSharedChatText("hello world")).not.toBe(hashSharedChatText("hello\nworld"));
  });
});
