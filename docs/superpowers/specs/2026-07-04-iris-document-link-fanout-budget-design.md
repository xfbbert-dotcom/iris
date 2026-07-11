# Iris Document Link Fan-Out Budget Design

## Goal

Prevent a single Feishu group message from creating an unbounded number of document registrations
and sync jobs.

## Architecture

Document link discovery now uses a per-message fan-out budget of `20` distinct supported Feishu or
Lark document links.

The budget is enforced in two places:

- `FeishuDocumentLinkExtractor` stops returning links after the first `20` distinct normalized
  document URLs.
- `GroupVisibleDocumentRegistrar` also caps deduplicated links at `20` before registering sources
  or planning sync jobs.

The double boundary keeps normal event processing cheap and also protects direct registrar callers.

## Invariants

- Existing supported Feishu and Lark document links still normalize the same way.
- Query strings and fragments are still removed before deduplication.
- Duplicate links do not consume extra registration work.
- The first `20` distinct normalized document links from a message are preserved in message order.
- Empty or unsupported links are still ignored.

## Out Of Scope

- Adding a user-facing warning when a message contains more than `20` document links.
- Changing document source registry policies.
- Changing document sync worker concurrency.
- Changing message text storage budgets.
