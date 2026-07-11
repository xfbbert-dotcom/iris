# Iris Mention Fact Persistence Isolation Design

## Context

The Feishu message processor receives one raw event that may need to:

- answer an explicit @Iris mention;
- persist the message as conversation memory;
- discover and register document links.

Previous hardening isolated mention replies from document discovery failures,
but message fact persistence still ran before the mention responder. A transient
conversation store failure could therefore make Iris silent even when the user
made an explicit request.

## Decision

After parsing and runtime gating, the processor attempts the explicit mention
reply before writing the conversation fact. Message fact persistence still runs
after that reply attempt and still throws on failure.

This keeps the visible chat assistant responsive while preserving memory
recovery through the existing raw-event retry path.

## Error Ordering

- If the mention reply fails, the processor still attempts message fact
  persistence and document discovery when possible, then surfaces the mention
  error.
- If message fact persistence fails after a successful mention reply, the
  persistence error is surfaced and document discovery is skipped.
- If document discovery fails after a reply and successful fact persistence, the
  document discovery error is surfaced.

## Guarantees

- Explicit mention replies are not blocked by conversation-store write failures.
- Conversation memory failures are not swallowed.
- Document discovery does not run when the authoritative message fact failed to
  persist.
- Existing runtime gates remain authoritative.
