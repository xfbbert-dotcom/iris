# Iris Document Context Blank Fragment Filter Design

## Problem

Document parsing can produce blank or whitespace-only chunks. If those chunks pass retrieval and permission checks, Iris currently sends them into `<background_documents>`.

Blank document context wastes prompt space and can make answer drafting less predictable.

## Decision

Filter blank allowed fragments in `DocumentRetrievalContextBuilder` before building prompt context and before returning `allowedFragments`.

A fragment is blank when `fragment.text.trim().length === 0`.

`retrievedFragmentCount` still reports the raw number of retrieved fragments before permission and blank-content filtering.

## Quality Bar

- Blank fragments must not appear in prompt context.
- Blank fragments must not appear in `allowedFragments`.
- `retrievedFragmentCount` continues to reflect raw vector retrieval count.
- Permission checks still run before blank filtering, preserving audit behavior.
