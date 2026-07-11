# Iris Feishu Document Source HTTPS-Only Design

## Context

Iris extracts Feishu document links from group chat with an HTTPS-only matcher, but the shared
Feishu source URI parser also powers manual registration, document body fetching, runtime
registration, and live permission checks. That parser must enforce the same transport boundary.

Accepting `http://` or other non-HTTPS Feishu-looking URLs can make internal/manual paths behave
differently from chat discovery and can store source URIs that are not canonical Feishu document
links.

## Decision

The shared Feishu document source parser only accepts absolute HTTPS URLs on supported Feishu or
Lark document hosts.

This means:

- `https://docs.feishu.cn/docx/...`, `https://*.feishu.cn/docs/...`, and
  `https://*.larksuite.com/wiki/...` remain supported.
- `http://...`, `ftp://...`, and other non-HTTPS schemes are unsupported.
- Embedded credentials, unsupported hosts, and unsupported path shapes remain unsupported.
- Query strings and fragments may still be parsed for token extraction, but registration paths
  normalize them away before storage.

## Scope

This is a source URI validation hardening change. It does not change Feishu OpenAPI base URL
configuration, token fetching, document body parsing, or permission-check response handling.

## Acceptance Criteria

- Shared docx/docs parser returns `undefined` for non-HTTPS Feishu-looking URLs.
- Shared wiki parser returns `undefined` for non-HTTPS Feishu-looking URLs.
- Internal manual document registration rejects non-HTTPS Feishu-looking URLs before runtime calls.
- Direct document sync runtime registration rejects non-HTTPS Feishu-looking URLs before registry
  writes.
- Live permission checks treat non-HTTPS Feishu-looking URLs as unsupported and avoid tenant-token
  requests.
