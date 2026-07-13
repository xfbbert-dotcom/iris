# Iris Pilot Fail-Closed And Diagnostics Design

## Status

Approved for implementation on 2026-07-13 after the pilot backup restart restored Iris to the
in-memory default enabled state.

## Goal

Keep the single-group pilot safe across Core restarts and make model-quota and Feishu-permission
failures accurately diagnosable without changing the architecture whitepaper's service boundaries.

## Scope

This correction contains three independent, bounded changes:

1. Configure the Core runtime's initial global state through
   `IRIS_RUNTIME_GLOBAL_ENABLED`; the pilot Compose default is `false`.
2. Read useful provider messages when an OpenAI-compatible endpoint wraps its error object in a
   top-level array, as Gemini does.
3. Treat Feishu Wiki error code `131006` as an ordinary permission denial, including when Feishu
   returns it with HTTP 400.

Durable runtime-control state in Postgres, automatic quota switching, model replacement, retry
policy changes, and new admin UI work are out of scope.

## Runtime Startup Contract

`createDefaultRuntimeConfig()` keeps its development-compatible default of globally enabled when
`IRIS_RUNTIME_GLOBAL_ENABLED` is absent. The value accepts only exact boolean strings after
trimming and case normalization. Invalid configured values fail startup instead of silently
enabling Iris.

The production pilot Compose file passes `IRIS_RUNTIME_GLOBAL_ENABLED` with a default of `false`.
Consequently, a backup restart, container recreation, host reboot, or crash recovery returns Iris
to a globally disabled state. An operator must explicitly enable Iris through the existing runtime
control API after checking health. This is fail-closed startup policy, not durable runtime state;
group and capability mutations remain in memory.

## Provider Error Contract

`readExternalErrorMessage()` continues to prefer `error.message`, `msg`, then `message`. When the
bounded JSON response is a top-level array, it checks entries in order and returns the first useful
message under the same precedence and 512-character bound. Empty, malformed, or nested-array-only
responses still return `unknown error`.

No retry or model-selection behavior changes. The existing provider exception will now include the
Gemini quota reason instead of `unknown error`.

## Feishu Permission Contract

Feishu Wiki `get_node` may return HTTP 400 with code `131006` when the tenant application no longer
has permission to read the node. The permission checker returns `false` for this exact code before
classifying the HTTP status as transient. The permission guard therefore excludes the source and
records an ordinary denial.

Unknown HTTP 400 responses, token failures, malformed responses, timeouts, and 5xx responses keep
throwing and remain observable as permission-guard errors. This preserves fail-closed behavior and
does not broaden document access.

## Verification

- Unit tests cover absent, true, false, and invalid startup configuration.
- Pilot Compose tests require the fail-closed default.
- Error-parser and model-provider tests cover Gemini's array-wrapped quota body.
- Permission-checker tests cover HTTP 400/code `131006` and retain the unknown-400 error case.
- Full repository verification must pass before a commit-pinned image is built.
- Deployment must start with Caddy stopped, prove runtime state is disabled after Core recreation,
  and only restore Caddy after the remaining live gates pass.

