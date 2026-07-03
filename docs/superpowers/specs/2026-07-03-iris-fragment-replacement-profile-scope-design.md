# Iris Fragment Replacement Profile Scope Design

## Context

`document_fragments` stores `embedding_profile_id`, and retrieval searches only the active profile. Fragment replacement previously deleted all fragments for a snapshot before inserting the new profile's fragments.

That is too broad once multiple profiles can coexist. Reindexing a snapshot for one embedding profile should not erase fragments produced for another profile.

## Decision

`replaceFragmentsForSnapshot` must delete existing fragments by both:

- `document_snapshot_id`;
- `embedding_profile_id`.

Embedding rows remain protected by `on delete cascade` through the deleted fragment rows.

## Scope

This does not change search behavior, indexing profile selection, or embedding table routing. It only narrows the destructive replacement delete to the profile being replaced.

## Quality Bar

- Replacing fragments for one profile preserves other profile fragments for the same snapshot.
- Existing replacement insert order and vector table routing remain unchanged.
