# Iris Model Finish Reason Design

## Context

Iris uses an OpenAI-compatible chat completion adapter to draft answers. The adapter currently reads
the first message content without checking whether the provider reported a truncated completion.
If a provider returns `finish_reason: "length"`, Iris could send a partial answer into a group chat.

## Decision

When the first choice includes `finish_reason`, Iris should accept only normal completion:

- `finish_reason: "stop"` is accepted.
- `finish_reason: null` or an omitted field is accepted for provider compatibility.
- any other explicit finish reason is rejected before answer text is returned.

This keeps the v1 adapter simple while preventing known incomplete outputs from being treated as
finished answers.

## Error Handling

Non-normal finish reasons throw:

`model provider response did not finish normally`

The caller already maps generation failures to the existing answer-draft error path.

## Testing

Add a focused model provider test for `finish_reason: "length"` with otherwise valid content. Run
focused tests, then the full verification suite.
