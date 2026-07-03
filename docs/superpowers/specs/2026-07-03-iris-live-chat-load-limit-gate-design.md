# Iris Live Chat Load Limit Gate Design

## Context

Prompt assembly caps live chat to the latest 20 messages, but the orchestrator and live chat provider could still request an oversized history window before final prompt assembly. That wastes database work and can increase memory pressure even though the prompt later trims it.

## Decision

Cap live chat loading at the same 20-message ceiling used by prompt assembly:

- The answer orchestrator normalizes `liveChatLimit` before calling the live chat provider and before building context.
- The live chat provider also caps oversized limits before querying the conversation repository.

## Scope

This does not change the default live chat behavior or message ordering. It only prevents oversized explicit limits from propagating into storage reads and context building.

## Quality Bar

- Oversized orchestrator limits call the provider with `limit: 20`.
- Oversized provider limits query the repository with `limit: 20`.
- Existing smaller custom limits remain unchanged.
