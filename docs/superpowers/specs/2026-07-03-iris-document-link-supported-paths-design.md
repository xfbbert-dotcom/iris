# Iris Document Link Supported Paths Design

## Problem

`FeishuDocumentLinkExtractor` accepts any URL on supported Feishu or Lark hosts. The downstream body fetcher currently supports direct docx/docs URLs and wiki nodes, but rejects file URLs and other Feishu product paths.

If Iris registers unsupported paths from group chat, the document source inventory accumulates sources that predictably fail sync, making the small-company rollout noisier and harder to trust.

## Requirements

- Extract only Feishu/Lark paths that the body fetcher can read today: `docx`, `docs`, and `wiki`.
- Keep query/hash stripping and deduplication unchanged.
- Continue ignoring unrelated hosts.

## Non-goals

- Do not add file/sheet/bitable body fetch support in this patch.
- Do not change wiki resolution behavior.
- Do not change registrar semantics.

## Acceptance

- `/file/...` Feishu links are ignored by the extractor.
- `/minutes/...` and other unsupported product paths are ignored by the extractor.
- Existing docx/docs/wiki extraction continues to work.
- Full verification remains green.
