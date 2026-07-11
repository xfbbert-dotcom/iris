# Iris Feishu Long Message ID Idempotency Design

## Goal

Keep Feishu callback retries idempotent when the callback lacks a usable event ID and the available
`message_id` is valid by itself but too long to fit after Iris adds the `message:` namespace prefix.

## Architecture

The Feishu Gateway keeps the raw-event idempotency priority order:

1. valid platform event ID;
2. valid message ID fallback;
3. canonical body hash.

For the message fallback, Iris now derives the bounded raw event ID component as:

- `message:<message_id>` when the prefixed value fits the raw event ID budget;
- `message-hash:<sha256(message_id)>` when the raw message ID is non-blank but the prefixed value
  would exceed that budget.

This preserves ack-first gateway behavior because hashing one bounded request string is lightweight.
It also avoids body-hash fallback for retry wrappers whose `retry_count` or other metadata changes
between attempts.

## Invariants

- Long message IDs never create oversized Redis idempotency keys.
- Two callbacks for the same long message ID produce the same raw-event idempotency key even if
  wrapper retry metadata changes.
- Existing short message IDs keep the human-readable `message:<message_id>` format.
- Canonical body hash remains the final fallback when no non-blank message ID exists.

## Out Of Scope

- Changing Redis queue seen-key semantics.
- Changing Feishu event ID priority.
- Persisting the compact message hash as a user-facing message identifier.
