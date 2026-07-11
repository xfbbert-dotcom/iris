# Iris Answer Retrieval Stale Source Pushdown Design

## Problem

Answer-time source policy treats document sources in `stale` permission state as denied. However,
the pgvector query currently excludes only `denied` sources. Stale fragments can therefore occupy
the bounded candidate window before the permission guard removes them.

A highly similar stale document can contribute many chunks and crowd out readable documents. Iris
then answers without useful background evidence even though safe evidence exists later in the
ranking. This is both a retrieval-quality problem and unnecessary exposure of ineligible rows to
the answer-time permission pipeline.

## Decision

Restrict document fragment vector search to sources whose local permission state is `unknown` or
`readable`, in addition to the existing `can_use_for_answering = true` requirement.

- `denied` and `stale` sources do not enter the vector candidate set.
- `unknown` remains eligible for candidate retrieval because production `source-policy` mode still
  requires the real-time Feishu permission guard before prompt injection.
- Local policy checks and the Feishu live permission guard remain mandatory after retrieval. SQL
  filtering is an early narrowing step, not an authorization replacement.
- No new configuration or repository API is introduced.

This also keeps development `allow-indexed` mode from using stale fragments. A stale source is only
safe when a later live permission check is guaranteed, and `allow-indexed` intentionally does not
provide that guarantee.

## Quality Bar

- Vector search SQL selects only `unknown` and `readable` document sources.
- Stale fragments cannot consume candidate slots.
- Existing source-type pushdown, local source policy, and live Feishu permission checks remain
  unchanged.
- Focused retrieval tests and full repository verification pass.
