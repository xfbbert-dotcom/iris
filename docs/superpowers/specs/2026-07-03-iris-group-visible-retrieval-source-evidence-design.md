# Iris Group-Visible Retrieval Source Evidence Design

## Context

Group-visible document sources derive their answer-time visibility from the
Feishu groups where Iris observed the document. Runtime controls can disable a
group. If a source has no origin group and no evidence group IDs, Iris cannot
prove that the document belongs to any enabled group.

## Decision

When source-policy retrieval evaluates a group-visible document and the runtime
controller supports group-level checks, Iris requires at least one nonblank
source group ID. Missing group evidence is treated as denied and the fragment
does not enter `<background_documents>`.

User-submitted and authorized wiki sources keep their existing policies.

## Scope

This only affects answer-time source-policy retrieval. It does not change source
registration, document sync, or existing group evidence collection.

## Verification

- RED: runtime test showed a group-visible source without group evidence entered
  prompt context.
- GREEN: runtime test passes after missing group evidence is denied.
