# Iris Feishu Link Fullwidth Punctuation Design

## Problem

Feishu group messages often place document links before Chinese fullwidth punctuation such as `，`, `。`, `；`, `：`, `！`, `？`, `）`, and `】`.

If those punctuation characters are captured as part of the URL, Iris can register an invalid or non-canonical document URI.

## Decision

Make `FeishuDocumentLinkExtractor` explicitly stop URL matching at common CJK fullwidth punctuation and trim those characters when they appear at the end of a candidate URL.

## Quality Bar

- A URL followed by `，` or `。` is extracted without punctuation.
- Existing ASCII punctuation trimming continues to work.
- Deduplication continues to use normalized URLs.
