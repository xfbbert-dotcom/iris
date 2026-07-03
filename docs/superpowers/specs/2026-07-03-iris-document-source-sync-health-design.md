# Iris Document Source Sync Health Design

## Context

Source inventory and detail endpoints can include `latestSnapshot`, but admin UI still has to interpret raw snapshot fields to display a simple health state. For a small internal team, the source list should be immediately scannable without duplicating this interpretation in every client.

## Goal

Add a lightweight `syncHealth` view model whenever source responses are enriched with latest snapshot data.

## Non-Goals

- No new persisted health table.
- No alerting, SLA, or background monitor.
- No change to default source responses.
- No full body text or preview exposure.

## HTTP Behavior

When `includeLatestSnapshot=true`, source inventory rows and source detail responses include:

```json
{
  "syncHealth": {
    "status": "failing",
    "latestSnapshotId": "snapshot-1",
    "lastFetchedAt": "2026-07-03T04:00:00.000Z",
    "errorMessage": "Feishu returned 403"
  }
}
```

Statuses:

- `never_synced`: no snapshot exists for the source.
- `healthy`: latest snapshot exists and `fetchStatus` is `succeeded`.
- `failing`: latest snapshot exists and `fetchStatus` is `failed`.

Behavior:

- `syncHealth` is returned only when `includeLatestSnapshot=true`.
- `latestSnapshot` is still omitted when no snapshot exists.
- `syncHealth` never includes body text.

## Architecture Notes

This is an API-layer view model derived from the latest snapshot summary. It keeps the admin UI simple while avoiding an early health-cache abstraction that is unnecessary for a 20-30 person internal deployment.
