# Iris Group Document Link Normalized Dedup Design

## Problem

`GroupVisibleDocumentRegistrar` deduplicates repeated group document links by exact `sourceUri`. If extraction yields the same URL with surrounding whitespace in one occurrence, the registrar treats it as a different link and can register and sync-plan the same document twice.

The downstream registry already trims `sourceUri`, so registrar deduplication should use the same normalized identity.

## Decision

Normalize group-discovered links by trimming `sourceUri` before deduplication and registration.

The first normalized URI is kept. Later duplicates with different surrounding whitespace are skipped.

## Quality Bar

- Whitespace variants of the same link register only once.
- The registry receives the trimmed `sourceUri`.
- Distinct normalized links still register independently.
