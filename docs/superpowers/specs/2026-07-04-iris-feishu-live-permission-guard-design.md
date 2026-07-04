# Iris Feishu Live Permission Guard Design

## Problem

Iris already filters retrieved answer fragments through local source policy, but local registry state cannot catch delayed or indirect Feishu permission changes. The architecture whitepaper requires a real-time permission guard before document fragments enter the LLM context.

## Scope

- Add a lightweight Feishu document permission checker for answer-time retrieval.
- Use Feishu OpenAPI credentials when they are configured.
- Keep the existing local source policy as the first gate.
- Treat failed, timed-out, unsupported, or denied live checks as not readable.
- Do not introduce a separate Permission Guard Service in this phase.

## Architecture

The answer draft runtime will compose:

1. Local registry policy: source exists, is usable for answering, permission state is `unknown` or `readable`, and runtime capabilities allow the source type.
2. Optional Feishu live guard: when Feishu OpenAPI credentials are available, perform a lightweight document accessibility probe for the source URI before allowing fragments into prompt context.

Direct docx/docs URLs are checked by calling the Feishu document metadata endpoint. Wiki URLs are resolved through the wiki node endpoint and then checked through the document metadata endpoint. Network failures and timeouts throw from the checker; the existing permission guard catches those errors, excludes fragments, and writes `permission_guard_error` audit events.

## Non-Goals

- No user-level delegated permission model.
- No permission-token cache.
- No cross-source batch permission API.
- No changes to document sync fetching semantics.

## Acceptance Criteria

- Direct Feishu doc URLs are checked against Feishu before use.
- Wiki node URLs are resolved and checked before use.
- Denied or unsupported documents are excluded from answer prompt context.
- Runtime wiring only enables the live guard when Feishu OpenAPI credentials are configured.
- Existing local-only development tests continue to pass.
