# Iris Redis URL Config Design

## Context

Iris worker runtimes share `REDIS_URL`. The current config reader trims the value
and passes it to the Redis client without validating URL shape or protocol. A
deployment typo can therefore fail later inside the Redis library instead of at
configuration loading.

## Decision

`REDIS_URL` must be validated when an enabled worker config is read:

- blank values still default to `redis://localhost:6379`;
- valid `redis://` and `rediss://` URLs are accepted;
- credentials and database paths remain allowed because Redis URLs commonly use
  them;
- non-URL strings and non-Redis protocols are rejected.

## Error Handling

Invalid Redis URLs throw:

`REDIS_URL must be a redis URL`

## Testing

Add env tests proving `rediss://` URLs with credentials are accepted and invalid
or non-Redis URLs are rejected.
