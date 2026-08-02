import { describe, expect, it } from "vitest";

import type {
  RetrievedDocumentFragment,
  RetrievedDocumentSourceType,
} from "../src/documents/document-fragment-repository.js";
import { renderAnswerWithSourceCitations } from "../src/answer-replies/answer-source-citation-renderer.js";

const checkedAt = new Date("2026-08-02T04:05:06.000Z");

describe("answer source citation renderer", () => {
  it("preserves first fragment order, deduplicates visible documents, and traces every fragment", () => {
    const result = renderAnswerWithSourceCitations({
      answerText: "Answer body",
      allowedFragments: [
        fragment({
          documentSourceId: "source-wiki-a",
          documentSnapshotId: "snapshot-a",
          id: "fragment-a-2",
          chunkIndex: 2,
          sourceTitle: "Wiki A",
          sourceType: "feishu_wiki",
          sourceUri: "https://tenant.feishu.cn/wiki/wikiA?from=chat#section",
        }),
        fragment({
          documentSourceId: "source-group-b",
          documentSnapshotId: "snapshot-b",
          id: "fragment-b-0",
          chunkIndex: 0,
          sourceTitle: "Group B",
          sourceType: "feishu_group_document",
          sourceUri: "https://tenant.feishu.cn/docx/docB?from=chat",
        }),
        fragment({
          documentSourceId: "source-wiki-a",
          documentSnapshotId: "snapshot-a",
          id: "fragment-a-3",
          chunkIndex: 3,
          sourceTitle: "Wiki A",
          sourceType: "feishu_wiki",
          sourceUri: "https://tenant.feishu.cn/wiki/wikiA",
        }),
        fragment({
          documentSourceId: "source-user-c",
          documentSnapshotId: "snapshot-c",
          id: "fragment-c-0",
          chunkIndex: 0,
          sourceTitle: "User C",
          sourceType: "manual_upload",
          sourceUri: "https://tenant.feishu.cn/docx/docC",
        }),
        fragment({
          documentSourceId: "source-wiki-d",
          documentSnapshotId: "snapshot-d",
          id: "fragment-d-0",
          chunkIndex: 0,
          sourceTitle: "Wiki D",
          sourceType: "feishu_wiki",
          sourceUri: "https://tenant.feishu.cn/wiki/wikiD",
        }),
      ],
      initialPermissionCheckedAt: checkedAt,
    });

    expect(result.renderedText).toContain(
      "Iris 参考资料：\n" +
        "[1] [知识库] Wiki A\nhttps://tenant.feishu.cn/wiki/wikiA\n" +
        "[2] [群文档] Group B\nhttps://tenant.feishu.cn/docx/docB\n" +
        "[3] [用户文档] User C\nhttps://tenant.feishu.cn/docx/docC",
    );
    expect(result.renderedText).not.toContain("Wiki D");
    expect(result.sourceTraces).toHaveLength(5);
    expect(result.sourceTraces.map((trace) => trace.promptRank)).toEqual([1, 2, 3, 4, 5]);
    expect(result.sourceTraces.map((trace) => trace.citationRank)).toEqual([
      1,
      2,
      1,
      3,
      undefined,
    ]);
    expect(result.sourceTraces[0]).toEqual({
      promptRank: 1,
      citationRank: 1,
      documentSourceId: "source-wiki-a",
      documentSnapshotId: "snapshot-a",
      fragmentId: "fragment-a-2",
      chunkIndex: 2,
      sourceType: "feishu_wiki",
      sourceUri: "https://tenant.feishu.cn/wiki/wikiA",
      sourceTitle: "Wiki A",
      contentHash: "hash-fragment-a-2",
      embeddingProfileId: "profile-1",
      initialPermissionCheckedAt: checkedAt,
    });
    expect(JSON.stringify(result.sourceTraces)).not.toContain("Life Engine context");
  });

  it("omits the footer and traces when no document fragments were allowed", () => {
    const result = renderAnswerWithSourceCitations({
      answerText: "Answer body",
      allowedFragments: [],
      initialPermissionCheckedAt: checkedAt,
    });

    expect(result).toEqual({ renderedText: "Answer body", sourceTraces: [] });
  });

  it("normalizes query and fragment parts out of canonical Feishu URLs", () => {
    const result = renderAnswerWithSourceCitations({
      answerText: "Answer body",
      allowedFragments: [
        fragment({
          sourceUri: "https://tenant.feishu.cn/wiki/wikiA/?from=chat#section",
        }),
      ],
      initialPermissionCheckedAt: checkedAt,
    });

    expect(result.renderedText).toContain("https://tenant.feishu.cn/wiki/wikiA");
    expect(result.renderedText).not.toContain("from=chat");
    expect(result.renderedText).not.toContain("#section");
    expect(result.sourceTraces[0]?.sourceUri).toBe("https://tenant.feishu.cn/wiki/wikiA");
  });

  it("rejects HTTP, credential-bearing, non-Feishu, and malformed source URLs", () => {
    for (const sourceUri of [
      "http://tenant.feishu.cn/wiki/wikiA",
      "https://user:password@tenant.feishu.cn/wiki/wikiA",
      "https://example.com/wiki/wikiA",
      "not a URL",
    ]) {
      expect(() =>
        renderAnswerWithSourceCitations({
          answerText: "Answer body",
          allowedFragments: [fragment({ sourceUri })],
          initialPermissionCheckedAt: checkedAt,
        }),
      ).toThrow();
    }
  });

  it("rejects conflicting URI, title, or source type metadata for one document ID", () => {
    const cases: Array<Partial<RetrievedDocumentFragment>> = [
      { sourceUri: "https://tenant.feishu.cn/wiki/wikiB" },
      { sourceTitle: "Different title" },
      { sourceType: "manual_upload" },
    ];

    for (const conflict of cases) {
      expect(() =>
        renderAnswerWithSourceCitations({
          answerText: "Answer body",
          allowedFragments: [
            fragment({ documentSourceId: "same-source", ...conflict }),
            fragment({ documentSourceId: "same-source" }),
          ],
          initialPermissionCheckedAt: checkedAt,
        }),
      ).toThrow();
    }
  });

  it("uses 飞书文档 when the registered title is blank", () => {
    const result = renderAnswerWithSourceCitations({
      answerText: "Answer body",
      allowedFragments: [fragment({ sourceTitle: "   " })],
      initialPermissionCheckedAt: checkedAt,
    });

    expect(result.renderedText).toContain("[知识库] 飞书文档");
    expect(result.sourceTraces[0]?.sourceTitle).toBeUndefined();
  });

  it("truncates a visible title to 120 characters with the shared marker", () => {
    const result = renderAnswerWithSourceCitations({
      answerText: "Answer body",
      allowedFragments: [fragment({ sourceTitle: "T".repeat(121) })],
      initialPermissionCheckedAt: checkedAt,
    });

    expect(result.renderedText).toContain(`[知识库] ${"T".repeat(104)} ... [truncated]`);
    expect(result.renderedText).not.toContain("T".repeat(121));
    expect(result.sourceTraces[0]?.sourceTitle).toBe("T".repeat(104) + " ... [truncated]");
  });

  it("reserves the footer before truncating an 8000-character answer body", () => {
    const result = renderAnswerWithSourceCitations({
      answerText: "A".repeat(8000),
      allowedFragments: [fragment({ sourceTitle: "Wiki A" })],
      initialPermissionCheckedAt: checkedAt,
    });

    expect(result.renderedText.length).toBeLessThanOrEqual(8000);
    expect(result.renderedText).toContain(" ... [truncated]");
    expect(result.renderedText.endsWith("https://tenant.feishu.cn/wiki/wikiA")).toBe(true);
  });

  it("rejects a footer whose own bounded content cannot fit in 8000 characters", () => {
    const longTenant = "tenant-" + "x".repeat(7950);

    expect(() =>
      renderAnswerWithSourceCitations({
        answerText: "Answer body",
        allowedFragments: [
          fragment({
            documentSourceId: "long-source",
            sourceUri: `https://${longTenant}.feishu.cn/wiki/wikiA`,
          }),
        ],
        initialPermissionCheckedAt: checkedAt,
      }),
    ).toThrow();
  });
});

function fragment(
  overrides: Partial<RetrievedDocumentFragment> = {},
): RetrievedDocumentFragment {
  const sourceType: RetrievedDocumentSourceType = overrides.sourceType ?? "feishu_wiki";
  return {
    id: "fragment-1",
    documentSourceId: "source-1",
    documentSnapshotId: "snapshot-1",
    sourceUri: "https://tenant.feishu.cn/wiki/wikiA",
    chunkIndex: 0,
    text: "Life Engine context",
    contentHash: "hash-fragment-a-2",
    embedding: [1, 0, 0],
    embeddingProfileId: "profile-1",
    createdAt: new Date("2026-08-02T03:00:00.000Z"),
    sourceType,
    ...overrides,
  };
}
