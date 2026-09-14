export function parsePdFeedback(text: string): "pause" | "resume" | null {
  const body = text.trim().replace(/[。！!]+$/u, "");
  if (body === "不再跟进这件事") return "pause";
  if (body === "恢复跟进这件事") return "resume";
  return null;
}
