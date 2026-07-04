# Iris External Base URL Config Validation Design

## Goal

Reject invalid external HTTP base URLs during configuration loading instead of letting model,
embedding, or Feishu OpenAPI requests fail later at runtime.

## Architecture

Add one shared config helper for external base URLs:

- trims the environment value through the existing required-env path;
- parses it with `new URL()`;
- accepts only `http:` and `https:` protocols;
- preserves the existing trailing-slash normalization.

Use the helper for:

- `IRIS_MODEL_BASE_URL`
- `IRIS_EMBEDDING_BASE_URL`
- `FEISHU_OPEN_BASE_URL`

## Invariants

- Valid HTTP(S) URLs continue to be trimmed and normalized without trailing slash.
- Blank required base URLs still use the existing `<NAME> is required` errors.
- Malformed or non-HTTP(S) base URLs fail with `<NAME> must be an http(s) URL`.
- Provider and Feishu timeout behavior is unchanged.

## Out Of Scope

- Provider-specific host allowlists.
- URL reachability checks.
- Changing default Feishu OpenAPI base URL.
