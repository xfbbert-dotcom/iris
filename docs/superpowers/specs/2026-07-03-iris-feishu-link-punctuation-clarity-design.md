# Iris Feishu Link Punctuation Clarity Design

## Context

The Feishu document link extractor trims ASCII and fullwidth chat punctuation after copied document links. The punctuation character set existed as mojibake text, making the rule hard to review and risky to edit even though behavior was covered by tests.

## Decision

Represent fullwidth trailing punctuation with explicit Unicode escape sequences in the extractor and tests.

## Scope

- Does not add new document URL shapes.
- Does not change query-string or fragment removal.
- Does not change host allowlisting.

## Quality Bar

- Fullwidth comma and ideographic full stop after links are trimmed.
- Existing ASCII punctuation trimming and dedupe behavior stays unchanged.
- The punctuation set is readable and patchable in source control.
