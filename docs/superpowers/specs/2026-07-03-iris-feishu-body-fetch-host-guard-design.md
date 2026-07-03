# Iris Feishu Body Fetch Host Guard Design

## Problem

`parseFeishuDocxDocumentId()` and `parseFeishuWikiNodeToken()` parse tokens from URL paths without validating the hostname. A manually registered source such as `https://evil.com/docx/doc_token` can be treated as a Feishu document token and sent to the Feishu OpenAPI.

Group-discovered links already pass through host filtering, but manual and authorized source registration can provide arbitrary source URIs. The body fetch boundary must enforce host ownership too.

## Requirements

- Parse docx/docs/wiki tokens only from supported Feishu/Lark hosts.
- Keep existing docx/docs/wiki path parsing behavior for valid hosts.
- Keep unsupported URL shapes returning `undefined`.

## Non-goals

- Do not change source registration APIs.
- Do not add new document product support.
- Do not change Feishu OpenAPI request shapes.

## Acceptance

- `parseFeishuDocxDocumentId("https://evil.com/docx/token")` returns `undefined`.
- `parseFeishuWikiNodeToken("https://evil.com/wiki/token")` returns `undefined`.
- Fetching a non-Feishu source URI rejects as an unsupported Feishu docx URL.
- Full verification remains green.
