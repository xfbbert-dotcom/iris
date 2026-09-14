export function parsePdFeedback(text: string): "pause" | "resume" | null {
  const body = text.trim().replace(/[。！!]+$/u, "");
  if (body === "不再跟进这件事") return "pause";
  if (body === "恢复跟进这件事") return "resume";
  return null;
}

// The key must come from trusted ingress metadata for the configured bot. This
// helper only matches the literal prefix; displayed names and quotes are not proof.
export function removePdFeedbackMention(text: string, key?: string): string {
  if (key === undefined || !key || key.length > 512 || key.trim() !== key || !text.startsWith(key)) return text;
  const boundary = text.slice(key.length, key.length + 1);
  return boundary.length === 0 || /\s/u.test(boundary) ? text.slice(key.length).trimStart() : text;
}
