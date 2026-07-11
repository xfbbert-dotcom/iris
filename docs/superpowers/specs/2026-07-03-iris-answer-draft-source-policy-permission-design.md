# Iris Answer Draft Source Policy Permission Design

## Context

The answer draft runtime already sends retrieved fragments through `filterFragmentsByLivePermission`, but the composed runtime still wires `canReadDocument` as `async () => true`. That keeps development convenient, but it means admin-disabled, denied, stale, or missing sources can still reach model context if their fragments remain indexed.

For the first internal deployment, Iris needs a small, reliable guard before a full Feishu real-time permission API checker exists.

## Goal

Add a `source-policy` answer draft permission mode that checks the local document source registry before any retrieved fragment enters `<background_documents>`.

## Non-Goals

- No Feishu live permission API calls in this phase.
- No permission cache service.
- No new database tables.
- No changes to document sync or source registration.

## Behavior

`IRIS_INTERNAL_DRAFT_PERMISSION_MODE` supports:

- `allow-indexed`: current development mode; every retrieved indexed document is allowed.
- `source-policy`: local fail-closed policy for internal use.

In `source-policy`, a document source is allowed only when:

- the source exists;
- `canUseForAnswering` is `true`;
- `permissionState` is `unknown` or `readable`.

The source is denied when:

- the source is missing;
- `canUseForAnswering` is `false`;
- `permissionState` is `denied` or `stale`;
- registry lookup throws.

This still is not the final Feishu real-time guard. It is an intermediate safety layer that prevents known-local policy violations from reaching the model.

## Architecture

`createAnswerDraftRuntime()` composes the Postgres document source registry alongside the fragment repository. The runtime chooses `canReadDocument` from the configured permission mode:

- `allow-indexed`: return `true`;
- `source-policy`: call `findSourceById(documentSourceId)` and apply the local policy.

The existing `DocumentRetrievalContextBuilder` remains the single enforcement point before prompt assembly.

## Testing

- Env config accepts `source-policy` and still rejects unsupported values.
- Runtime tests prove `source-policy` filters disabled, denied, stale, missing, and lookup-error sources from the prompt.
- Existing `allow-indexed` behavior remains unchanged.
