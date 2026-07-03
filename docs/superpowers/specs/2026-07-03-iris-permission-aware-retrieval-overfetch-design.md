# Iris Permission-Aware Retrieval Overfetch Design

## Context

Document retrieval first ranks fragments by semantic similarity, then runs the live permission guard before prompt assembly. If the search window is exactly the final prompt window, denied fragments can occupy every retrieved slot and prevent Iris from seeing slightly lower-ranked but readable fragments.

This is especially visible in shared Feishu groups where knowledge-base, group-visible, and manually submitted sources can have different access policies.

## Decision

`DocumentRetrievalContextBuilder` now overfetches semantic candidates before permission filtering:

- Final requested fragment window remains capped at 12.
- Search candidate window is `finalLimit * 3`, capped at 36.
- Permission checks run on meaningful retrieved candidates.
- Returned allowed fragments and prompt background documents are trimmed back to the final requested limit.

This improves recall after denied documents are removed without increasing the final prompt size.

## Scope

- Does not change vector repository ranking.
- Does not change real-time permission guard semantics.
- Does not change prompt assembly's final 12-document hard limit.
- Does not overfetch when `fragmentLimit` is 0.

## Quality Bar

- Readable fragments behind denied candidates can still reach the prompt.
- Denied fragments never enter the prompt.
- Candidate expansion remains bounded and predictable.
