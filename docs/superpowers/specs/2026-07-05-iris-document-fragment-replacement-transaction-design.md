# Iris Document Fragment Replacement Transaction Design

## Context

Document fragment replacement is destructive. Iris deletes existing fragments for a snapshot/profile
and then inserts the new chunks plus vector embeddings. Prevalidation already prevents invalid caller
input from deleting good fragments, but a database failure after the delete can still leave a latest
successful snapshot with a partial or empty semantic index.

## Decision

When the configured queryable exposes `connect()`, `replaceFragmentsForSnapshot` must execute all
delete, fragment insert, and embedding insert mutations inside a single database transaction:

- acquire a client with `connect()`;
- run `begin`;
- run the existing delete and insert sequence against that client;
- run `commit` after all fragments and embeddings have been inserted;
- run `rollback` and release the client if any mutation fails.

The repository keeps its current `Queryable` fallback for test doubles or callers that only expose
`query()`. Production Postgres pools support `connect()`, so the runtime path becomes atomic without
changing the public repository API.

## Invariants

- Existing prevalidation still runs before the first database mutation.
- Successful replacement returns the same `DocumentFragment[]` shape as before.
- A failed mutation rolls back the replacement instead of leaving partial fragments visible.
- Client release always runs after commit or rollback attempts.
- Search, listing, and dimension routing behavior do not change.

## Out Of Scope

- Retrying failed database mutations.
- Changing chunking, embedding, or retrieval ranking logic.
- Making non-transactional test doubles atomic.
