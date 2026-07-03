# Iris Feishu Body Fetch Path Prefix Design

## Problem

The Feishu body fetcher validates supported hosts, but `parseFeishuPathToken()` still searches for `docx`, `docs`, or `wiki` anywhere in the path. A URL such as `https://acme.feishu.cn/minutes/docx/token` can be parsed as a document even though the first product path is not a supported document product.

The link extractor already treats the first path segment as the product marker. Body fetching should use the same rule.

## Requirements

- Accept docx/docs/wiki only when the first path segment matches the requested marker set.
- Preserve token parsing for valid `https://.../docx/:token`, `https://.../docs/:token`, and `https://.../wiki/:token`.
- Keep host validation unchanged.

## Non-goals

- Do not add new Feishu product support.
- Do not change wiki node resolution.
- Do not change source registration behavior.

## Acceptance

- `parseFeishuDocxDocumentId("https://acme.feishu.cn/minutes/docx/token")` returns `undefined`.
- `parseFeishuWikiNodeToken("https://acme.feishu.cn/drive/wiki/token")` returns `undefined`.
- Existing valid path parsing remains green.
- Full verification remains green.
