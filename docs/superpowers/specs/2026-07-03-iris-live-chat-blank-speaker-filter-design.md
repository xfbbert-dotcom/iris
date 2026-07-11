# Iris Live Chat Blank Speaker Filter Design

## Context

Prompt context assembly already filters live chat messages whose text is blank. It did not filter messages whose speaker label is blank, so a direct caller could produce prompt XML such as `<message speaker="">...`.

That weakens prompt clarity and makes live chat context harder for the model to attribute, especially during early internal use where stored message data may be incomplete.

## Decision

`assemblePromptContext` must treat live chat messages as meaningful only when both fields are nonblank after trimming:

- `speaker` must be nonblank.
- `text` must be nonblank.
- Valid messages are still trimmed and XML-escaped before formatting.

## Scope

This is a prompt hygiene guard only. It does not change stored conversation messages, Feishu parsing, or answer orchestration dedupe.

## Quality Bar

- Blank-speaker live chat messages are excluded from prompt context.
- Existing blank-text filtering, trimming, XML escaping, and live chat limit behavior remain unchanged.
