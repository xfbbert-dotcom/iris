# Iris Fragment Replacement Prevalidation Design

## Context

Replacing document fragments is a destructive write: the repository deletes existing fragments for a snapshot, then inserts the new chunks and embeddings. If invalid replacement input is discovered only after the delete, Iris can lose a previously usable index and make a document disappear from retrieval.

## Decision

Before deleting existing fragments, the fragment repository must validate the complete replacement set:

- chunk and embedding counts must match;
- every chunk index must resolve to an embedding;
- every embedding must match the active profile dimension;
- every embedding value must be finite.

Only after this prevalidation passes may the repository delete and replace stored fragments.

## Scope

This does not add transaction management to the repository. It reduces preventable destructive writes caused by invalid caller input before the first database mutation.

## Quality Bar

- Invalid replacement vectors are rejected before any delete or insert query.
- Existing successful replacement, search, and dimension validation behavior remains unchanged.
