# Iris GitHub Actions Node 24 Upgrade Design

## Status

Approved for autonomous implementation on 2026-07-13 after PR #4 CI passed with GitHub's Node 20
deprecation annotation.

## Goal

Remove the deprecated Node 20 action runtime from Iris CI without changing application behavior,
job structure, test coverage, or deployment policy.

## Observed State

The CI workflow uses `actions/checkout@v4`, `actions/setup-node@v4`, and
`actions/setup-python@v5`. GitHub currently forces the Node 20 actions to Node 24 and emits a
deprecation annotation for checkout and setup-python.

The official action repositories currently document these supported major versions:

- `actions/checkout@v7`
- `actions/setup-node@v6`
- `actions/setup-python@v6`

Their documented minimum runner requirement is compatible with GitHub-hosted `ubuntu-latest`.

## Alternatives

### A. Upgrade all three official actions to current majors (selected)

This removes the warning and keeps the Node and Python jobs on one current action-runtime
generation. It follows the repository's existing major-tag update convention.

### B. Upgrade only the two actions named in the warning

This is smaller but leaves setup-node on an older major for no compatibility reason and creates
avoidable version drift. It is rejected.

### C. Pin action commits

Immutable commit pins reduce supply-chain drift but introduce a repository-wide dependency update
policy change. Docker images are pinned by digest, while this workflow currently tracks official
action major tags. That broader policy decision is outside this maintenance change.

## Change Contract

Only the three `uses` values change. Node remains version 22, Python remains version 3.12, caching
remains unchanged, and every job step keeps the same name, order, environment, and command.

The architecture whitepaper remains unchanged. No production container, secret, permission,
runtime-control, queue, or ingress setting changes.

## Verification

- `git diff --check` passes.
- The workflow diff contains only the three intended action-major updates.
- PR #4 Core and AI Worker jobs both pass on the updated commit.
- The completed run no longer contains the Node 20 deprecation annotation.
