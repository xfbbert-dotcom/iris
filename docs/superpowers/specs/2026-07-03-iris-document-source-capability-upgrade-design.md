# Iris Document Source Capability Upgrade Design

## Problem

When the same document URI is first registered as `user_submitted_document`, it defaults to `canUseForKnowledgeDrafts: false`. If the same URI is later registered as `authorized_wiki_document`, the registry upgrades `sourceType` but keeps the old capability flags.

That means an admin-authorized wiki document can still be blocked from knowledge draft usage because it was first seen through a lower-trust path.

## Decision

When merging duplicate document sources, upgrade knowledge-draft capability using logical OR:

- `canUseForKnowledgeDrafts = existing.canUseForKnowledgeDrafts || next.canUseForKnowledgeDrafts`

`canUseForAnswering` continues to preserve the existing source value during re-registration. This keeps an admin-disabled answering policy from being silently re-enabled by later discovery.

The existing denied-permission guard remains authoritative: when permission is marked `denied`, answering stays disabled.

## Quality Bar

- Admin authorization can upgrade a previously user-submitted source for knowledge drafts.
- Re-registering a source must not silently re-enable answering.
- Existing tests for denied permission and disabled answering remain passing.
- Registry tests cover the capability upgrade.
