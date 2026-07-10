# Iris Answer Retrieval Query Live Chat Design

## Problem

Iris loads recent group chat into the final answer prompt, but the semantic retrieval query used
only the user's current question. In group chat, many useful requests are follow-ups: "What about
this?", "What are the risks?", or "How should we schedule the next step?". Those questions rely on
the preceding live discussion. A question-only embedding can miss relevant document fragments even
though Iris has already loaded the live-chat context for answer generation.

## Decision

Build the answer retrieval query from:

- the trimmed user question; and
- the selected, deduplicated, bounded live-chat window.

The user question stays first. Live chat is appended only within the existing 4000-character
retrieval query budget. If the question already consumes the budget, Iris searches with the question
alone rather than truncating the user's request.

This does not change final prompt assembly: background documents still render before
`<live_chat_context>`, and live chat remains closest to the model answer.

## Quality Bar

- Follow-up questions include recent live-chat facts in `queryText`.
- `queryText` never exceeds the existing 4000-character retrieval budget.
- Live-chat ordering, trimming, deduplication, and prompt anchoring remain unchanged.
