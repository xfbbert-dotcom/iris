# Iris Feishu Document Token Budget Design

## Goal

Prevent oversized Feishu document or wiki tokens from entering document fetch and permission-check
API calls.

## Architecture

Feishu document token parsing now applies a `512` character maximum to:

- docx/docs URL path tokens,
- wiki URL path tokens,
- wiki `get_node` response `obj_token` values used as document IDs.

The content fetcher rejects oversized wiki `obj_token` responses as missing document tokens. The
permission checker treats the same response as unreadable and returns `false`.

## Invariants

- Normal Feishu and Lark docx/docs/wiki URLs continue to parse unchanged.
- Unsupported hosts, HTTP URLs, embedded credentials, and unsupported paths remain rejected.
- Oversized URL tokens are ignored before tenant-token or Feishu API requests are made.
- Oversized wiki response document tokens do not trigger a follow-up document metadata or raw
  content request.
- Permission checks remain fail-closed.

## Out Of Scope

- Changing supported Feishu URL shapes.
- Changing source URI registration budgets.
- Changing document raw content size budgets.
- Changing Feishu tenant token behavior.
