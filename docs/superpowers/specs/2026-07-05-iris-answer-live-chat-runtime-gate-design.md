# Iris Answer Live Chat Runtime Gate Design

## Problem

`readGroupContext` already prevents new Feishu messages from being persisted when group context
reading is disabled. However, answer drafting can also load previously persisted group messages
through the live chat context provider.

If this path is not gated, an administrator may disable group-context reading while Iris continues to
use old group chat history in model prompts.

## Decision

Answer draft runtime must gate stored live chat retrieval through the shared runtime controller:

- when `canReadGroupContext(chatId)` is false, do not call the stored live chat provider;
- keep explicit request-scoped `liveChatMessages` supplied by the caller, because those represent
  the current user request rather than passive historical memory;
- preserve existing behavior when no runtime controller is supplied, so unit and development
  compositions remain simple.

## Non-Goals

- Do not change document retrieval gates.
- Do not block the current explicit mention question when `replyWhenMentioned` is enabled.
- Do not delete previously persisted conversation messages.

## Quality Bar

- Disabling group-context reading keeps stored live chat history out of answer prompts.
- The current explicit request context can still be included in answer prompts.
- The live chat provider is not called for disabled group-context reads.
