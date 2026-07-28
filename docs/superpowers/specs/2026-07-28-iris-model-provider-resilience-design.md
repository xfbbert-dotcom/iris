# Iris Model Provider Resilience Design

## Status

Approved on 2026-07-28 as option A. This is a release-blocker repair for the
20-30 person internal pilot, not a new hardening phase.

## Observed Failure

The production answer path failed after authorized retrieval had already
succeeded:

- the exact user-submitted document was embedded and retrieved;
- the live Feishu permission guard allowed the source;
- the complete answer prompt contained the expected marker;
- `gemini-3.5-flash` returned HTTP 503 with a temporary high-demand message.

A minimal request to `gemini-3.6-flash` returned HTTP 200. A full internal
orchestration using that model retrieved the same authorized source and
returned the correct marker, but it added explanatory formatting despite an
exact-output request.

The repair therefore belongs at the answer-model boundary and prompt policy.
It must not change retrieval, permission, indexing, or source-precedence logic.

## Decision

### Model

Set the production answer model to `gemini-3.6-flash` through
`IRIS_MODEL_NAME`. Keep the model name environment-driven so the adapter
remains provider-compatible and future model changes do not require code
changes.

Do not add a lower-quality fallback model. A failed primary model request must
end in Iris's safe user-facing degradation after the bounded retry policy is
exhausted.

### Request Compatibility

Omit `temperature` from the OpenAI-compatible request. Gemini 3.6 uses the
provider default, avoiding deprecated sampling controls and preserving a
portable request contract.

Strengthen the system prompt:

- when the current question explicitly asks for only or exactly one value,
  return only that value;
- do not add a label, explanation, quotation marks, Markdown, or a code fence;
- safety and permission policies remain higher priority.

### Retry Policy

The provider may make at most two attempts in total: the initial request and
one retry.

Retry once only for transient failures:

- HTTP 408;
- HTTP 500;
- HTTP 502;
- HTTP 503;
- HTTP 504;
- a transport-level network failure represented by `TypeError`.

Do not retry:

- HTTP 429, because retrying consumes quota without changing the active quota
  window;
- permanent HTTP 4xx responses such as 400, 401, 403, or 404;
- aborts and exhausted deadlines;
- malformed, truncated, blank, or oversized provider responses;
- application validation failures.

Wait once before the retry using a bounded exponential base delay of 750 ms
plus up to 250 ms of jitter.

### Total Deadline

`IRIS_MODEL_TIMEOUT_MS` is one total deadline for the complete provider call,
including the delay and both attempts. Each attempt receives only the
remaining budget. A fast 503 can be retried; an attempt that consumes the
deadline cannot.

The implementation injects clock, sleeper, and random dependencies for
deterministic tests. Production defaults use `Date.now`, `setTimeout`, and
`Math.random`.

## Failure Behavior

After retry exhaustion, preserve the original `ModelProviderHttpError`,
including its final HTTP status and bounded external error message. Timeout
continues to surface as `model provider request timed out`.

The existing Feishu 429 message remains unchanged. Other exhausted provider
failures remain fail-closed and must not manufacture an answer from stale or
denied data. User-facing handling outside 429 is a separate product decision
and is not expanded by this patch.

## Security Invariants

- Retrieval scope and live permission checks do not change.
- Denied or unavailable document content is never included or inferred.
- Model retries reuse only the already-authorized prompt assembled for the
  current request.
- No retry is allowed after the total deadline.
- No automatic fallback model is introduced.
- Production remains globally disabled and Caddy stopped during deployment and
  internal acceptance.

## Acceptance

Automated:

- request JSON omits `temperature`;
- the prompt contains the exact-output rule;
- a 503 followed by 200 returns the successful answer after exactly one wait;
- two 503 responses surface the second 503 after exactly two requests;
- 429 and 401 make exactly one request and do not sleep;
- a transport `TypeError` retries once;
- malformed successful responses do not retry;
- a consumed total deadline prevents a second request;
- the focused provider suite, Core typecheck, Core build, and repository CI
  checks pass.

Bounded deployment:

1. verify the production fail-closed baseline;
2. deploy Core and AI Worker images from the same candidate SHA;
3. set only the answer model to `gemini-3.6-flash`;
4. run an internal exact-answer gate with the authorized pilot document;
5. only after the internal gate passes, briefly open the pilot-only Feishu
   ingress behind an automatic close timer;
6. verify one real exact-output answer and a disabled control boundary;
7. restore fail-closed and record service, queue, DLQ, image, and commit
   evidence.

Do not merge the pull request as part of this acceptance.
