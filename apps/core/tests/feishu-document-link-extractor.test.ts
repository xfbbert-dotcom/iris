import { describe, expect, it } from "vitest";

import { createFeishuDocumentLinkExtractor } from "../src/documents/feishu-document-link-extractor.js";

describe("FeishuDocumentLinkExtractor", () => {
  it("extracts supported Feishu and Lark document links", () => {
    const extractor = createFeishuDocumentLinkExtractor();

    expect(
      extractor.extractLinks(
        "看这两个文档 https://docs.feishu.cn/docx/abc 和 https://acme.larksuite.com/wiki/space/doc",
      ),
    ).toEqual([
      { sourceUri: "https://docs.feishu.cn/docx/abc" },
      { sourceUri: "https://acme.larksuite.com/wiki/space/doc" },
    ]);
  });

  it("ignores unrelated URLs", () => {
    const extractor = createFeishuDocumentLinkExtractor();

    expect(
      extractor.extractLinks("普通链接 https://example.com/doc 不应该进入 Iris 文档源"),
    ).toEqual([]);
  });

  it("trims trailing chat punctuation and deduplicates repeated links", () => {
    const extractor = createFeishuDocumentLinkExtractor();

    expect(
      extractor.extractLinks(
        "链接：https://foo.feishu.cn/docx/token)，再发一次 https://foo.feishu.cn/docx/token。",
      ),
    ).toEqual([{ sourceUri: "https://foo.feishu.cn/docx/token" }]);
  });
});
