# Iris Feishu Document URL Exact Path Design

**Goal:** Feishu document source URLs must resolve to exactly one supported document or wiki token before Iris registers, syncs, or retrieves the source.

**Problem:** The shared Feishu URL parser accepted extra path segments after `/docx/:token`, `/docs/:token`, or `/wiki/:token`. A copied or malformed URL such as `https://example.feishu.cn/wiki/space/doc` could be registered, while the sync and permission layers would only use `space` as the wiki token. It also accepted percent-encoded separators inside the token segment, such as `%2F` or `%5C`, which can hide an intended extra path boundary from segment-based validation.

**Design:** Keep the existing shared parser as the single validation point for group link discovery, authorized wiki registration, user-submitted registration, body sync, and permission checks. Tighten the parser so supported Feishu document URLs must have exactly two non-empty path segments: the supported marker and the token. Query strings, fragments, and trailing path slashes remain allowed and are stripped by canonicalization; extra path segments are rejected. The token segment must not contain percent-encoded content, so encoded path separators and double-encoding attempts fail before registration.

**Quality Bar:** This change preserves the v1 small-team scope while improving core correctness. Iris should prefer rejecting an ambiguous document URL over registering a source that cannot reliably map to the intended Feishu document.
