# Iris Feishu Fetcher Validate Before Auth Design

## Context

`FeishuDocumentBodyFetcher` rejected unsupported document URL shapes, but it requested a tenant access token before checking whether the URL could ever be fetched. A bad source URI could therefore be masked by authentication failures and could spend credentials work on links Iris already knows it cannot read.

## Decision

The fetcher now validates the source URI shape first:

- direct docx/docs URLs are parsed before auth,
- wiki URLs are parsed before auth but still resolve their document id after auth,
- unsupported URLs fail before requesting a tenant token,
- supported URLs continue through the same Feishu API calls as before.

## Scope

- Does not change supported Feishu URL types.
- Does not change wiki node resolution behavior.
- Does not change raw content parsing or error messages for Feishu API failures.

## Quality Bar

- Unsupported URL shapes do not call the token provider.
- Unsupported URL errors are not hidden by authentication errors.
- Existing docx, user-submitted, and wiki fetch flows still work.
