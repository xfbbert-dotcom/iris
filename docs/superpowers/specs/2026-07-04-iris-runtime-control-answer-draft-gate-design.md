# Iris Runtime Control Answer Draft Gate Design

## Problem

Runtime control now gates Feishu ingestion and queued message processing, but the
internal answer-draft API can still call the orchestrator while Iris is globally
disabled or disabled for the request chat.

That creates a bypass for reply generation, which conflicts with the admin
control requirement that disabling Iris stops new replies and actions.

## Decision

Gate `POST /internal/answer-drafts` with the shared `RuntimeController` after
request validation and before calling the orchestrator:

- global disabled blocks all answer draft generation
- per-group disabled blocks requests with that `chatId`
- allowed scopes continue through the existing draft path

Return HTTP 403 with `iris_runtime_disabled` when blocked.

## Non-Goals

- Do not change answer orchestration internals.
- Do not block admin status or audit endpoints.
- Do not add persistent runtime-control state.

## Quality Bar

- Disabled global state prevents answer draft generation.
- Disabled group state prevents answer draft generation for that chat.
- Enabled groups still generate drafts normally.
