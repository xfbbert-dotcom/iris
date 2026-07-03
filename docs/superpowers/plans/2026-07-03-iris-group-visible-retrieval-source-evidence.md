# Iris Group-Visible Retrieval Source Evidence Plan

## Goal

Fail closed when answer retrieval cannot prove which enabled group made a
group-visible document visible.

## Tasks

- [x] Add a failing answer-runtime test for a group-visible document source with
  no origin group and no evidence group IDs.
- [x] Change group-visible source-policy retrieval to deny missing group
  evidence when group-level runtime gating is available.
- [x] Preserve user-submitted document retrieval in the same answer.
- [x] Record the visibility guardrail in the Iris whitepaper.

## Verification

- `npm test -- tests/answer-draft-runtime.test.ts`
