# Iris Feishu Mention Answer Reply Design

Date: 2026-07-04
Status: Focused MVP behavior for internal group usage

## Goal

Let Iris answer in Feishu when a group message explicitly mentions the Iris bot.

## Trigger Rule

Iris replies only when all conditions are true:

- the event is `im.message.receive_v1`;
- the message is in a Feishu group or topic group that Iris can process;
- the message `mentions` array contains the configured `IRIS_FEISHU_BOT_OPEN_ID`;
- runtime control allows `replyWhenMentioned` for that group;
- answer-draft runtime and Feishu OpenAPI credentials are configured.

This keeps the first internal rollout predictable. Iris can observe broader group traffic when
permissions allow it, but automatic replies stay explicit and opt-in by mention.

## Data Flow

```text
Raw Feishu event
-> FeishuMessageEventProcessor persists message facts
-> FeishuMentionAnswerResponder checks mention and runtime gate
-> AnswerDraftOrchestrator builds safe context and answer text
-> FeishuMessageReplier replies to the source message
-> FeishuMessageEventProcessor discovers group-visible document links
```

The reply uses a deterministic Feishu `uuid` derived from the source message id. If Feishu retries
the same event or Iris retries the raw-event worker, Feishu can deduplicate the visible reply for the
supported dedupe window.

Document discovery and sync planning are not allowed to prevent an explicit @Iris reply attempt.
After message fact persistence, the processor attempts mention response first, then attempts document
link discovery. If document discovery fails, the processor rethrows the error after the reply attempt
so the raw-event worker can retry document memory recovery without making the current user-visible
reply wait on the document sync queue.

Iris also keeps a bounded in-process mention reply deduper keyed by the source `messageId`. This
deduper claims a message while a reply is in flight, remembers successful replies and
runtime-disabled suppressions, and releases the claim when answer generation or reply dispatch fails.
Feishu `uuid` remains the platform-side visible reply guard; the local deduper prevents duplicate
model generation, delayed old-message replies after runtime re-enable, and duplicate reply API calls
during retry or concurrent delivery windows.

## Question Extraction

Feishu text content often includes mention keys such as `@_user_1`. The responder removes only the
configured Iris mention keys from the question text, trims whitespace, and leaves other user mentions
intact.

If the remaining question is blank, Iris replies with a short clarification instead of calling the
model.

## Safety Boundaries

- Runtime control remains authoritative. `replyWhenMentioned` or a disabled group prevents replies.
- Iris does not reply to messages sent by its own bot open ID, even if that message mentions Iris.
- The responder does not bypass answer-draft retrieval, source policy, or permission guards.
- The responder does not send replies directly through generic fetch; it uses `FeishuMessageReplier`.
- Reply retries use a stable bounded UUID.
- Duplicate Feishu deliveries for the same `messageId` are skipped locally while a reply is in
  flight or after a successful reply; failed attempts release the local claim so a retry can proceed.
- A mentioned message suppressed by runtime control is also remembered locally so a later duplicate
  delivery does not answer an old message after replies are re-enabled.
- Missing `IRIS_FEISHU_BOT_OPEN_ID`, missing Feishu OpenAPI credentials, or disabled answer-draft
  runtime means the event worker still stores facts but does not auto-reply.

## Scope

In scope:

- Mention detection by `open_id`.
- Question cleanup from Feishu mention keys.
- Static clarification reply for blank mentions.
- Answer draft generation and Feishu text reply dispatch.
- Event processor integration.
- Event worker runtime composition from env and existing runtime controller.

Out of scope:

- Responding to unmentioned group messages.
- Direct-message behavior.
- Proactive messages.
- Rich cards, reactions, typing indicators, or streaming replies.
- Long-answer splitting.

## Testing

Add unit tests for the responder, processor integration, event runtime composition, and env config:

- mentioned bot triggers answer drafting and a Feishu reply;
- non-bot mentions skip;
- disabled runtime gate skips;
- blank mention replies with a clarification without model calls;
- duplicate deliveries after success or during in-flight reply generation skip without calling the
  model or Feishu reply API again;
- duplicate deliveries after a runtime-disabled suppression skip even if replies are later
  re-enabled;
- a retry after a failed reply attempt is allowed;
- processor passes parsed mentions to the responder without blocking replies when document reading is
  disabled;
- processor still attempts a mention reply when document discovery or sync planning fails, then
  propagates the discovery failure for worker retry;
- event runtime composes the responder only when bot open ID, Feishu OpenAPI config, and answer
  orchestrator are available.

## Rollout

For the internal 20-30 person rollout, operators must configure:

```powershell
$env:IRIS_FEISHU_BOT_OPEN_ID="<iris-bot-open-id>"
```

The bot still needs Feishu bot ability, receive-message event subscription, message send permission,
and the existing answer-draft/model/embedding configuration.
