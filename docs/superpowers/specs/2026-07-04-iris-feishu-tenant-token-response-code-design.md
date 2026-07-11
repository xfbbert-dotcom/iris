# Iris Feishu Tenant Token Response Code Design

## Context

Iris uses Feishu tenant access tokens before document reads and live permission checks. The provider
currently accepts an HTTP 200 response that omits Feishu's numeric `code` field when
`tenant_access_token` is present. That can cache or return a token from a malformed upstream
response.

## Decision

Require a numeric Feishu `code` before trusting tenant token responses:

- `code: 0` is required before `tenant_access_token` is read.
- numeric non-zero `code` keeps the existing Feishu business-error message.
- missing or non-numeric `code` throws a malformed-response error.
- failed HTTP responses and invalid JSON keep the existing behavior.

The cache, refresh skew, timeout, and in-flight request coalescing behavior remain unchanged.

## Error Handling

Malformed successful responses throw:

`Feishu tenant access token response did not include code`

The provider already clears the in-flight promise in `finally`, so a later call can retry after the
malformed response is fixed.

## Testing

Add focused token-provider tests for HTTP 200 responses that include `tenant_access_token` but omit
or mis-type `code`. Run the focused test file, then the full verification suite.
