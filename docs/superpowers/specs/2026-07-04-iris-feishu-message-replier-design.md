# Iris Feishu Message Replier Design

Date: 2026-07-04
Status: Focused adapter for Iris v1 group reply MVP

## Goal

Add a small Feishu message reply adapter so Iris can eventually answer in the same group thread
where a user mentioned her.

## Feishu API Contract

Feishu's reply-message API uses:

- `POST /open-apis/im/v1/messages/:message_id/reply`
- `Authorization: Bearer <tenant_access_token>`
- JSON body with `msg_type`, serialized JSON `content`, optional `reply_in_thread`, and optional
  `uuid`

For the v1 internal rollout, Iris only needs text replies. The adapter sends:

```json
{
  "msg_type": "text",
  "content": "{\"text\":\"...\"}"
}
```

## Design

Create `FeishuMessageReplier` as a focused outbound adapter in `apps/core/src/feishu`:

- Accept `messageId`, `text`, optional `uuid`, and optional `replyInThread`.
- Acquire a tenant access token from the existing `FeishuTenantAccessTokenProvider`.
- Send the text reply through the Feishu reply-message endpoint.
- Enforce a bounded timeout across request and JSON body reading.
- Validate Feishu-style successful responses by requiring `code === 0`.
- Return the Feishu reply message id when the response includes one.

## Safety Boundaries

- Reject blank message IDs and blank reply text before token acquisition.
- Bound message IDs to `512` characters.
- Bound reply text to `8000` characters, matching Iris answer-draft output budget.
- Bound optional `uuid` to Feishu's documented `50` character maximum.
- Do not silently split messages in this adapter. If Iris later needs long-answer splitting, that
  should live in a higher-level reply formatter with explicit UX rules.

## Scope

In scope:

- Text reply adapter and unit tests.
- Timeout, malformed response, non-zero Feishu code, non-OK HTTP, and input validation behavior.

Out of scope:

- Detecting @Iris mentions.
- Generating answers from Feishu events.
- Sending cards, rich text, files, reactions, or typing indicators.
- Rate limiting. Feishu rate limits should be respected by the future outbound worker layer.

## Testing

Add `apps/core/tests/feishu-message-replier.test.ts` covering:

- Successful text reply request shape.
- Base URL trailing slash normalization.
- Optional `reply_in_thread` and `uuid`.
- Input validation before token acquisition.
- Timeout and aborted JSON body reads.
- Non-OK HTTP, non-zero Feishu code, missing code, malformed JSON, and invalid timeout config.

## Rollout

This adapter is not wired to automatic Feishu event processing in this patch. It is a safe building
block for the next step: mention-triggered answer drafting and reply dispatch.
