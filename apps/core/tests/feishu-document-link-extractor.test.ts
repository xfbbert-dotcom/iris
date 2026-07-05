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

  it("ignores unsupported Feishu product URL paths", () => {
    const extractor = createFeishuDocumentLinkExtractor();

    expect(
      extractor.extractLinks(
        "file https://foo.feishu.cn/file/file_token and minutes https://foo.feishu.cn/minutes/min_token",
      ),
    ).toEqual([]);
  });

  it("ignores supported Feishu document paths without document tokens", () => {
    const extractor = createFeishuDocumentLinkExtractor();

    expect(
      extractor.extractLinks(
        "missing tokens https://foo.feishu.cn/docx and https://foo.feishu.cn/wiki/",
      ),
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
        "doc https://docs.feishu.cn/docx/a\uFF0Canother https://foo.feishu.cn/docx/b\u3002",
      ),
    ).toEqual([
      { sourceUri: "https://docs.feishu.cn/docx/a" },
      { sourceUri: "https://foo.feishu.cn/docx/b" },
    ]);
  });

  it("drops copied link query strings and fragments before deduplication", () => {
    const extractor = createFeishuDocumentLinkExtractor();

    expect(
      extractor.extractLinks(
        "doc https://docs.feishu.cn/docx/token?from=from_copylink#heading and https://docs.feishu.cn/docx/token?open_in_browser=true",
      ),
    ).toEqual([{ sourceUri: "https://docs.feishu.cn/docx/token" }]);
  });

  it("bounds distinct document links extracted from a single message", () => {
    const extractor = createFeishuDocumentLinkExtractor();
    const text = Array.from(
      { length: 25 },
      (_, index) => `https://docs.feishu.cn/docx/token-${index}`,
    ).join(" ");

    const links = extractor.extractLinks(text);

    expect(links).toHaveLength(20);
    expect(links[0]).toEqual({ sourceUri: "https://docs.feishu.cn/docx/token-0" });
    expect(links[19]).toEqual({ sourceUri: "https://docs.feishu.cn/docx/token-19" });
  });

  it("ignores Feishu document links with embedded credentials", () => {
    const extractor = createFeishuDocumentLinkExtractor();

    expect(
      extractor.extractLinks("doc https://user:pass@foo.feishu.cn/docx/token"),
    ).toEqual([]);
  });

  it("ignores oversized Feishu document links before later valid links", () => {
    const extractor = createFeishuDocumentLinkExtractor();
    const oversizedToken = "a".repeat(2100);

    expect(
      extractor.extractLinks(
        `bad https://docs.feishu.cn/docx/${oversizedToken} good https://docs.feishu.cn/docx/valid`,
      ),
    ).toEqual([{ sourceUri: "https://docs.feishu.cn/docx/valid" }]);
  });
});
