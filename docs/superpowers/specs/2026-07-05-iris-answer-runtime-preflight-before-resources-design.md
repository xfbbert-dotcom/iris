# Iris Answer Runtime Preflight Before Resources Design

## Context

The answer-draft runtime can run in `source-policy` mode, where Feishu document fragments require
live permission checks. If Feishu OpenAPI is partially configured, `readOptionalFeishuOpenApiConfig()`
throws synchronously.

Before this fix, the runtime opened the Postgres pool and built repositories before reading that
optional Feishu config. A startup failure could therefore leave an opened pool that never becomes
reachable through an `AnswerDraftRuntime.close()` method.

## Decision

When answer drafts are enabled in `source-policy` mode, build the optional live Feishu permission
checker before opening the Postgres pool. If Feishu config is missing entirely, behavior remains
unchanged: the permission checker is unavailable and Feishu-backed fragments fail closed at answer
time.

## Invariants

- `allow-indexed` mode does not read optional Feishu OpenAPI config.
- Complete source-policy Feishu config still creates the live permission checker.
- Missing Feishu config still produces fail-closed answer behavior, not startup failure.
- Partial Feishu config fails fast before resources are opened.

## Out Of Scope

- Moving embedding initialization from answer time to startup.
- Changing permission guard policy.
- Changing answer-draft runtime public API.
