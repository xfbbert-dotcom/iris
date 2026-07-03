# Iris Group Document Batch Sync Planning Design

## Context

A single Feishu message can contain multiple document links. The registrar previously registered and planned sync one link at a time. If sync planning failed after the first registration, later links in the same message were not registered until the raw event was retried.

## Decision

Group-visible document discovery registers all deduplicated links first, then calls the sync planner once with the full registered source list.

This keeps evidence capture complete for the message and reduces planner calls. If sync planning fails, the raw event processor still sees a failure and can retry through the existing raw event retry/DLQ path, but the document source registry already contains every discovered source from that message.

## Scope

- Deduplication by trimmed `sourceUri` remains unchanged.
- Sync planner eligibility and enqueue behavior remain unchanged.
- Empty link lists still do nothing.

## Quality Bar

- Multiple links in one message produce one sync planning call containing every registered source.
- Existing single-link, duplicate-link, and sync-planner failure behavior remains covered.
