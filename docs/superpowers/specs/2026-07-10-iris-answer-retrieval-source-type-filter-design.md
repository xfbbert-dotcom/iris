# Iris Answer Retrieval Source Type Filter Design

## Problem

Runtime controls can disable group document reading or knowledge-base retrieval. The answer-time
source policy guard removed disallowed fragments before prompt assembly, but vector search still
retrieved candidates across every answering-enabled source type first. That means disabled source
categories could be read from the semantic index, consume candidate slots, and then be discarded.

For the first 20-30 person rollout, operator toggles should be simple and trustworthy: if a source
category is disabled, Iris should not search that category for answer evidence.

## Decision

Push allowed document source types into semantic search:

- Include `group_visible_document` only when `canReadDocuments()` is enabled.
- Include `authorized_wiki_document` only when `canRetrieveKnowledgeBase()` is enabled.
- Keep `user_submitted_document` searchable by default because it is a distinct user-provided
  source category and has no dedicated runtime capability yet.

Local source policy and live Feishu permission checks still run after retrieval as defense in depth.
This filter is an earlier narrowing step, not a replacement for permission checks.

## Quality Bar

- Disabled group-document or wiki categories do not enter the vector search result set.
- User-submitted documents remain available when group documents and knowledge-base retrieval are
  disabled.
- Existing prompt permission filtering and live permission guard behavior remain unchanged.
