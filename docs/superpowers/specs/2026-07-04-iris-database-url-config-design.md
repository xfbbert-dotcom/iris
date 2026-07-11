# Iris Database URL Config Design

## Context

`DATABASE_URL` is required for database-backed Iris operations. The current
config reader trims and returns any nonblank string, so malformed values or URLs
for the wrong database protocol fail later when the Postgres pool is created.

## Decision

`DATABASE_URL` must be validated during config loading:

- blank values still raise `MissingDatabaseConfigError`;
- `postgres://` and `postgresql://` URLs are accepted;
- credentials, database paths, and query parameters remain allowed because
  Postgres connection strings commonly use them;
- malformed URLs and non-Postgres protocols are rejected.

## Error Handling

Invalid nonblank database URLs throw:

`DATABASE_URL must be a postgres URL`

## Testing

Add focused database config tests for `postgresql://` URLs and invalid protocols,
then run the database config tests and full verification.
