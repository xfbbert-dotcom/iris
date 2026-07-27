import { describe, expect, it } from "vitest";

import { assertSemanticEvidenceIntegrity } from "../src/memory-extraction/semantic-evidence-integrity.js";

describe("assertSemanticEvidenceIntegrity", () => {
  const marker = "IRIS_GRAY_20260727_THETA";

  it("accepts readable UTF-8 evidence and ordinary question-mark emphasis", () => {
    expect(() =>
      assertSemanticEvidenceIntegrity({
        text: `${marker}：这个决定真的确认了吗??? 请继续核对。`,
        marker,
        messageId: "message-1",
      }),
    ).not.toThrow();
  });

  it("rejects Unicode replacement characters", () => {
    expect(() =>
      assertSemanticEvidenceIntegrity({
        text: `${marker}：权限核对已\uFFFD成。`,
        marker,
        messageId: "message-2",
      }),
    ).toThrow(/suspected lossy text encoding/u);
  });

  it("rejects long high-density ASCII question-mark replacement spans", () => {
    expect(() =>
      assertSemanticEvidenceIntegrity({
        text: `${marker}????????????????????????????????????????`,
        marker,
        messageId: "message-3",
      }),
    ).toThrow(/suspected lossy text encoding/u);
  });

  it("rejects text that no longer contains the requested marker", () => {
    expect(() =>
      assertSemanticEvidenceIntegrity({
        text: "完整但属于其他灰度的数据",
        marker,
        messageId: "message-4",
      }),
    ).toThrow(/no longer contains the requested marker/u);
  });
});
