# Iris Redis Document Raw Payload Preservation Design

## Problem

Invalid Redis queue payload diagnostics store the original `rawPayload`. The DLQ
parser currently uses the same trimmed string reader as ids and error messages.
If the malformed payload is an empty string or whitespace-only string, listing the
DLQ can still reject the diagnostic entry.

Operators need to see that exact raw payload, even when it is blank or whitespace.

## Decision

Parse invalid DLQ `rawPayload` with a dedicated raw string reader that preserves the
exact string and accepts empty strings. Continue to reject missing or non-string
`rawPayload` values.

## Non-Goals

- Do not stop trimming ids, error messages, or typed job fields.
- Do not change normal failed-job parsing.

## Quality Bar

- Empty and whitespace-only invalid raw payload diagnostics can be listed.
- The listed `rawPayload` preserves its exact string value.
- Missing or non-string raw payload diagnostics remain invalid.
