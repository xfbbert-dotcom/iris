# Iris Answer-Time Live Chat Context Design

Date: 2026-07-02
Status: Phase 2V design

## Goal

Phase 2V connects the Feishu message fact store to answer drafting. When Iris prepares an answer for a Feishu group, the TypeScript Core App should fetch the current group's most recent persisted messages and inject them into the prompt as the live chat context anchor.

This phase makes Phase 2U immediately useful: Iris can answer with awareness of the recent group conversation without requiring the caller to manually pass all recent messages.

## Scope

In scope:

- Add an answer-time live chat context loader that reads recent messages by `chatId`.
- Convert persisted conversation messages into `LiveChatMessage` values used by prompt assembly.
- Keep the latest live chat messages closest to the model answer position through the existing `<live_chat_context>` prompt section.
- Wire the loader into the answer draft runtime.
- Preserve the existing ability for tests and callers to pass explicit `liveChatMessages`.

Out of scope:

- Long-term group memory extraction.
- Thread-aware message retrieval.
- Document-link discovery in chat messages.
- Feishu sender display-name lookup.
- Proactive answer triggering.

## Architecture

The new boundary is `LiveChatContextProvider`.

It belongs to the conversation/memory boundary rather than the Feishu Gateway. Feishu Gateway ingests and enqueues events; the event worker persists message facts; answer-time orchestration reads those facts through a small provider.

The provider depends on `ConversationMessageRepository.listRecentByChat`. It returns `LiveChatMessage[]` in chronological order so prompt assembly can render the conversation naturally. The repository may return newest-first rows for efficient database reads; the provider normalizes the order before returning messages.

Answer drafting gains an optional `chatId` input. If `chatId` is present, the orchestrator asks the live chat provider for recent messages. Any explicit `liveChatMessages` from the caller are treated as the immediate request context and appended after stored messages. This preserves compatibility and keeps the user's current message closest to the answer position.

## Prompt Assembly Rule

The existing `assemblePromptContext` contract remains authoritative:

```xml
<background_documents>
  ...
</background_documents>

<live_chat_context>
  ...
</live_chat_context>
```

Phase 2V does not move document content after live chat. The recent group messages must remain in `<live_chat_context>`, after background documents, so live conversation remains the context anchor.

The default live chat limit remains 20. If both stored messages and explicit messages are present, the combined list is trimmed by existing prompt assembly logic.

## Error Handling

If `chatId` is absent, answer drafting behaves exactly as it does today.

If `chatId` is present and the live chat provider fails, answer drafting should fail instead of silently answering without recent group context. Silent fallback would make Iris appear confident while missing the core conversation state.

Blank message text is excluded from the live chat context. Unsupported message types may already be stored with `text = null`; they should not appear in the prompt until a later phase adds attachment or rich-message rendering.

## Testing

Tests must cover:

- provider converts recent persisted messages into chronological live chat messages;
- provider excludes messages without text;
- orchestrator loads stored messages when `chatId` is supplied;
- explicit live chat messages are appended after stored messages;
- runtime wires the Postgres conversation repository into the answer-time context provider.

## Constitutional Alignment

This phase implements the whitepaper's answer retrieval order for current group-chat context and reinforces the long-document washout guardrail. Iris reads recent chat facts from Postgres, uses them as prompt context, and keeps them separated from background documents with structured XML tags.
