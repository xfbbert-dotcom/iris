# Iris Mention Document Discovery Isolation Design

## Context

Feishu message processing can perform two important actions for one message:

- answer an explicit @Iris mention;
- discover document links and register them as group-visible sources for later sync.

Before this hardening pass, document discovery ran before the mention responder. If group-visible document registration or sync planning threw, the processor exited before Iris attempted to reply. That made a backend memory-recovery problem visible as a chat assistant outage.

## Decision

After message fact persistence, `FeishuMessageEventProcessor` attempts mention response before document discovery. It collects errors from the mention responder and document discovery separately:

- if mention response fails, the error is rethrown after document discovery is attempted;
- if document discovery fails, the error is rethrown after the mention response attempt;
- if both succeed, processing completes normally.

This keeps the raw-event worker retry semantics for failures while ensuring document discovery does not prevent a user-visible explicit reply attempt.

## Scope

- Does not change Feishu gateway acknowledgement behavior.
- Does not swallow document discovery failures.
- Does not change runtime gates for disabled events, disabled group-context reading, or disabled document reading.
- Does not make proactive replies possible; replies still require an explicit @Iris mention and responder runtime permission.

## Quality Bar

- A message with both an @Iris mention and a document link still reaches the mention responder if document discovery fails.
- The same document discovery failure is still propagated so worker retry/DLQ behavior remains visible.
- Disabled document reading still skips discovery but keeps mention replies available.
- Disabled incoming events still skip all processing.
