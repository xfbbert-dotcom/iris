# Iris Prompt Live Chat Blank Filter Design

## Problem

Live chat messages can become blank after trimming because of empty Feishu payloads, unsupported message types, or parsing edge cases.

Including blank messages in `<live_chat_context>` wastes prompt space and can make the conversation context harder for the model to read.

## Decision

Filter blank live chat messages inside `assemblePromptContext`.

A live chat message is blank when `message.text.trim().length === 0`. Blank messages are removed before the live chat limit is applied so the limit counts meaningful messages.

## Quality Bar

- Blank live chat messages must not render as `<message>` entries.
- Non-blank messages keep their original text content.
- Live chat limit applies after blank filtering.
- Existing XML escaping behavior remains unchanged.
