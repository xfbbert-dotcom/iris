# Iris Group Document Link Dedup Design

## Problem

A Feishu group message can contain the same document link more than once, either because someone pasted it repeatedly or because extraction sees equivalent link tokens in rich text.

The registry deduplicates evidence, but `GroupVisibleDocumentRegistrar` still calls registration and sync planning once per extracted link, causing duplicate queue planning work.

## Decision

Deduplicate discovered links by exact `sourceUri` inside `GroupVisibleDocumentRegistrar` before registration.

The first occurrence is kept. Later duplicates in the same registrar call are skipped.

## Quality Bar

- Duplicate links in one message register only once.
- Sync planning is called only once for the deduplicated source.
- Distinct links still register independently.
