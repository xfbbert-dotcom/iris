# Iris Mention Blank Answer Fallback Design

## Context

`AnswerDraftOrchestrator` rejects blank model output with `model answer draft must not be blank`. That is correct for internal APIs and model-quality enforcement, but it creates a poor Feishu group-chat experience when the request came from an explicit @Iris mention: the user sees silence while the raw-event worker may retry the same unusable path.

## Decision

The Feishu mention responder catches only the orchestrator's blank-answer error and sends a short fallback reply:

> 我没拿到可用答案，你可以换个说法再问我一次。

The responder still lets all other generation, retrieval, permission, and reply-dispatch errors propagate so the raw-event worker can retry and record failures.

## Guarantees

- Blank model output no longer creates a silent @Iris interaction.
- The fallback reply uses the same deterministic Feishu reply UUID as normal mention replies.
- After a successful fallback reply, the source `messageId` is marked handled so Feishu retries are skipped.
- If the fallback reply itself fails, the responder releases the local claim and the worker can retry.

## Non-Goals

- Changing `AnswerDraftOrchestrator` blank-answer validation.
- Masking general model provider errors or Feishu reply failures.
- Adding a new model-quality classifier in v1.
