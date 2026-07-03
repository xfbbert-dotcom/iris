# Iris Feishu Post Message Document Link Design

## Problem

Iris registers group-visible documents by extracting links from persisted Feishu message
text. The processor currently only reads text from `message_type: "text"`, so Feishu
rich text/post messages can be stored with `text: undefined`. Any document link embedded
as a rich text `href` is then invisible to the link extractor and the source registry.

## Decision

Teach `FeishuMessageEventProcessor` to derive readable text from `message_type: "post"`
content.

The processor parses the JSON content and recursively collects string values from these
fields:

- `title`
- `text`
- `href`
- `url`

Those fields capture visible rich text and embedded links without adding internal fields
such as `tag`, `user_id`, or message metadata to live chat context.

## Data Flow

1. Feishu raw event reaches the raw event worker.
2. `FeishuMessageEventProcessor` parses message metadata.
3. For `post` content, it builds a compact text string from readable rich text fields.
4. The existing `FeishuDocumentLinkExtractor` receives that text and applies the same
   host filtering, punctuation trimming, query/hash normalization, and dedupe behavior.
5. Group-visible document registration and sync planning continue through existing paths.

## Non-Goals

- Do not introduce a full Feishu post renderer.
- Do not extract every string value from rich text JSON.
- Do not change non-text/non-post message handling.

## Quality Bar

- A post message with a document `href` registers the document through the existing
  group-visible registrar path.
- Image and other non-text messages remain stored without text and do not trigger link
  registration.
