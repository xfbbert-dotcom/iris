import { createHash } from "node:crypto";

export type LocalMessageSourceBinding = { chatId: string; messageId: string; contentHash: string };

// Live bindings hash the entire readable body. A stored/truncated event body hash is
// only suitable for registration and must not be presented as the live body identity.
export function hashLocalMessageText(text: string): string {
  return createHash("sha256").update(text.replace(/\r\n/gu, "\n"), "utf8").digest("hex");
}
