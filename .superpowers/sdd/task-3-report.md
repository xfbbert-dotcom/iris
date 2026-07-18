# Task 3 Report: Render Complete, Version-Bound Feishu Cards

## Status

Complete. Implementation commit subject: `feat(core): render governed knowledge cards`.

## Implementation

- Added a pure deterministic Feishu JSON 2.0 renderer with a blue header, bounded metadata,
  complete untruncated Markdown body, one review-reason field, one rejection confirmation
  checkbox, and three form-submit actions.
- Callback values contain exactly `action`, `presentationId`, `draftId`, `revisionNumber`, and
  `draftVersion`. The renderer never includes evidence, draft body outside the dedicated Markdown
  body component, risk, reviewer role, or target details in callbacks.
- Enforced the existing 8,000 Unicode-code-point body limit, 24 KiB serialized UTF-8 JSON limit,
  and 100-component limit. Refusals return `review_required` and never truncate content.
- Computes a deterministic SHA-256 hash over the final serialized JSON.

## TDD Evidence

Initial RED command:

```powershell
npm --workspace apps/core test -- knowledge-card-renderer.test.ts
```

It failed as expected because `knowledge-card-renderer.js` did not exist.

After the minimal renderer implementation, the focused test suite passed. The tests cover complete
body preservation, labels, callback envelope exactness, no evidence leakage, deterministic JSON
and hash output, JSON escaping, non-BMP code-point counting, 8,001-code-point refusal, and 24 KiB
refusal.

## Final Verification

```text
npm --workspace apps/core test -- knowledge-card-renderer.test.ts
Test Files  1 passed (1)
Tests       5 passed (5)

npm --workspace apps/core run typecheck
tsc --noEmit exited 0

npm --workspace apps/core run build
tsc --project tsconfig.build.json exited 0

git diff --check
exited 0
```

## Self-Review

- Renderer scope is limited to card construction and its test; no HTTP, callbacks, queues,
  runtimes, routes, OAuth, ActionProposal, or publication behavior was added.
- The renderer reads only the current title, risk, body, presentation identifiers, and the provided
  safe display name. Evidence is not read or serialized.
- The destructive rejection path requires both an explicit card checkbox and a rejection-button
  confirmation prompt. Server-side validation remains responsible for enforcing submitted form
  values.

## Concerns

- Feishu JSON 2.0 caps an input component at 1,000 characters, so the client reason field is
  capped at 1,000 even though the existing server-side interaction contract accepts up to 2,000
  Unicode code points. This is an intentional client-side constraint, not a content truncation.
