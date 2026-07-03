# Iris Answer Runtime Retrieval Capability Gates Design

## Problem

Runtime capability controls can disable group document reading and knowledge-base
retrieval, but answer draft retrieval still relies only on source policy. Already
indexed fragments from group-visible documents or authorized wiki documents can
still enter the model prompt after those capabilities are disabled.

## Decision

Apply runtime retrieval capability gates inside the answer draft runtime's
document permission callback when source-policy mode is active:

- `group_visible_document` requires `canReadDocuments()`
- `authorized_wiki_document` requires `canRetrieveKnowledgeBase()`
- `user_submitted_document` remains available when its source policy permits it

The Core App passes its shared `RuntimeController` to the default answer draft
runtime.

## Non-Goals

- Do not add per-source capability overrides.
- Do not change source-policy permission states.
- Do not change the development-only allow-indexed mode behavior in this patch.

## Quality Bar

- Disabled group document reading excludes group-visible fragments from answer prompts.
- Disabled knowledge-base retrieval excludes authorized wiki fragments from answer prompts.
- User-submitted sources that remain policy-allowed can still be used.
