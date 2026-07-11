# Iris Feishu Wiki Document Resolution Design

## Context

Iris can discover and register Feishu wiki links, but the document body fetcher currently only reads direct `/docx/:id` and `/docs/:id` URLs. A Feishu wiki URL contains a wiki node token, not the real document token needed by the raw-content API.

Feishu's wiki node API returns the node's mounted object metadata, including the real document token (`obj_token`) and type (`obj_type`). Iris can use that token to fetch document raw content when the wiki node points to a document.

Reference: Feishu Open Platform `GET /open-apis/wiki/v2/spaces/get_node`.

## Goal

Allow the existing Feishu document body fetcher to read a single wiki URL when that wiki node points to a supported document object.

## Non-Goals

- No recursive wiki space traversal.
- No syncing all children under a wiki space.
- No support for Sheets, Bitable, Mind Notes, files, or other non-document object types.
- No additional source type.

## Behavior

`createFeishuDocumentBodyFetcher().fetch(source)` should resolve document ids as follows:

1. If `sourceUri` contains `/docx/:id` or `/docs/:id`, use the parsed id directly.
2. If `sourceUri` contains `/wiki/:token`, call:

```http
GET /open-apis/wiki/v2/spaces/get_node?token=:token
Authorization: Bearer <tenant_access_token>
```

3. Read `data.node.obj_token` and `data.node.obj_type`.
4. If `obj_type` is `docx` or `doc`, use `obj_token` as the document id for:

```http
GET /open-apis/docx/v1/documents/:obj_token/raw_content
Authorization: Bearer <tenant_access_token>
```

5. If `obj_type` is any other value, fail with an explicit unsupported object type error.

The fetcher may reuse the same tenant access token for both requests.

## Error Handling

- Invalid or unsupported URL shape: `unsupported Feishu docx URL`.
- Wiki node HTTP failure: `Feishu wiki node request failed with status <status>: <message>`.
- Wiki node non-zero code: `Feishu wiki node request failed: <message>`.
- Missing `obj_token` or `obj_type`: `Feishu wiki node response did not include document token`.
- Unsupported `obj_type`: `unsupported Feishu wiki object type: <type>`.
- Invalid wiki JSON: `Feishu wiki node response was not valid JSON`.

## Safety Notes

This only resolves one registered wiki node into one underlying document token. It does not grant new access. Feishu still enforces tenant token permissions, and Iris answer generation still must apply source policy and permission guards before using synced fragments.
