# Iris Unreadable Mention Feedback Design

## Context

`FeishuMessageEventProcessor` can detect @Iris mentions even when the event body
does not yield readable text. This can happen when the Feishu content payload is
oversized, malformed, or belongs to a message type whose body Iris does not yet
parse.

Before this hardening pass, the mention responder treated `text: undefined` the
same as an empty string. It replied with the blank-question clarification, which
is misleading: the user did not necessarily omit a question; Iris failed to read
the message body.

## Decision

When Iris is explicitly mentioned and `input.text` is `undefined`, the Feishu
mention responder sends:

> 我看到了你的 @Iris，但没读到可处理的文字内容。请用文字重新发给我一次。

This happens after runtime reply gating and duplicate claiming, but before
question stripping or answer draft generation.

## Guarantees

- Iris does not call the answer draft orchestrator without readable message
  text.
- The reply uses the same deterministic Feishu UUID path as normal mention
  replies.
- After a successful unreadable-message clarification, the source `messageId` is
  marked handled so Feishu retries do not duplicate the reply.
- If the clarification reply fails, the local claim is released and the raw-event
  worker can retry.

## Non-Goals

- Adding OCR, file parsing, image understanding, or audio transcription.
- Changing blank-question behavior when readable text exists but strips down to
  empty content after removing mention keys.
- Masking Feishu reply API errors.
