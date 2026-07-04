# Iris Runbook Internal Header Examples Design

## Goal

Make the internal rollout runbook examples copy-paste safe when `IRIS_INTERNAL_API_TOKEN` is set.
Operators should not have to remember to manually add `-Headers $irisHeaders` after copying an
internal API command.

## Architecture

Keep `/health` unauthenticated in examples. For every `Invoke-RestMethod` example that targets an
`/internal/*` route, include:

```powershell
-Headers $irisHeaders
```

The runbook still defines `$irisHeaders` once in the security boundary section. Each internal
example repeats the header argument so copied snippets work on their own after the variable is set.

## Invariants

- `/health` examples do not use the internal token.
- `/internal/*` examples include `-Headers $irisHeaders`.
- The runbook remains PowerShell-first for Windows operators.
- This is documentation only; no runtime behavior changes.

## Out Of Scope

- Adding curl examples.
- Building an admin UI.
- Changing the internal token scheme.
