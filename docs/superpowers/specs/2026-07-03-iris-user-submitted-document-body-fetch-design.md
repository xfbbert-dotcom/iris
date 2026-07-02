# Iris User Submitted Document Body Fetch Design

## Context

Iris can register user-submitted document sources and enqueue them for document sync. The Feishu body fetcher still rejects `user_submitted_document`, so those sources can enter the queue but cannot be read by the document sync runner.

## Goal

Allow user-submitted Feishu docx/docs URLs to use the same raw-content fetch path as group-visible and authorized wiki document sources.

## Non-Goals

- No new source type.
- No new Feishu API.
- No permission guard change.
- No support for Feishu wiki URLs in this phase.

## Behavior

`createFeishuDocumentBodyFetcher().fetch(source)` should accept these source types:

- `group_visible_document`
- `authorized_wiki_document`
- `user_submitted_document`

For all three types, the fetcher:

1. Parses the document id from `/docx/:id` or `/docs/:id`.
2. Reads a tenant access token.
3. Calls `/open-apis/docx/v1/documents/:id/raw_content`.
4. Returns trimmed body text and `fetchedAt`.

Unsupported URL shapes, including `/wiki/:id`, still fail with `unsupported Feishu docx URL`.

## Safety Notes

This change does not bypass answer-time permission checks. It only allows the sync worker to fetch body text for a source that an operator or user has already registered. Answer generation must still rely on source policy and permission guard behavior before passing document fragments to the model.
