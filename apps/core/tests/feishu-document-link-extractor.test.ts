import { describe, expect, it } from "vitest";

import { createFeishuDocumentLinkExtractor } from "../src/documents/feishu-document-link-extractor.js";

describe("FeishuDocumentLinkExtractor", () => {
  it("extracts supported Feishu and Lark document links", () => {
    const extractor = createFeishuDocumentLinkExtractor();

    expect(
      extractor.extractLinks(
        "docs: https://docs.feishu.cn/docx/abc and https://acme.larksuite.com/wiki/space/doc",
      ),
    ).toEqual([
      { sourceUri: "https://docs.feishu.cn/docx/abc" },
      { sourceUri: "https://acme.larksuite.com/wiki/space/doc" },
    ]);
  });

  it("ignores unrelated URLs", () => {
    const extractor = createFeishuDocumentLinkExtractor();

    expect(
      extractor.extractLinks("plain link https://example.com/doc should be ignored"),
    ).toEqual([]);
  });

  it("trims trailing chat punctuation and deduplicates repeated links", () => {
    const extractor = createFeishuDocumentLinkExtractor();

    expect(
      extractor.extractLinks(
        "link: https://foo.feishu.cn/docx/token), again https://foo.feishu.cn/docx/token.",
      ),
    ).toEqual([{ sourceUri: "https://foo.feishu.cn/docx/token" }]);
  });

  it("trims fullwidth punctuation after document links", () => {
    const extractor = createFeishuDocumentLinkExtractor();

    expect(
      extractor.extractLinks(
        "文档 https://docs.feishu.cn/docx/a，另一个 https://foo.feishu.cn/docx/b。",
      ),
    ).toEqual([
      { sourceUri: "https://docs.feishu.cn/docx/a" },
      { sourceUri: "https://foo.feishu.cn/docx/b" },
    ]);
  });
});
