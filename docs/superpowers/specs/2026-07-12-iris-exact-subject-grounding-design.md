# Iris Exact-Subject Grounding Design

## Status

Approved on 2026-07-12 after the live permission-denial pilot exposed a related-subject substitution.

## Problem

The live Feishu permission guard correctly excluded the revoked knowledge-base document containing
`IRIS_WIKI_6158`. The remaining authorized evidence contained the different fact
`IRIS_GROUP_DOC_4826`. When asked for the knowledge-base acceptance number, the model returned the
group-document acceptance number instead of saying the requested fact was unavailable.

This was not post-revocation memory leakage: the revoked fragment appeared in
`deniedDocumentIds`, did not enter model context, and its marker did not appear in Iris's answer.
The separate Feishu client "related knowledge" row is outside Iris's plain-text reply payload and is
governed by the viewing user's own Feishu permissions.

## Decision

Keep the architecture whitepaper unchanged. Strengthen the existing answer-draft system policy so
company-factual answers must match both the exact subject and exact attribute named in the current
Question. A fact about a different document, source type, project, person, date, or similarly named
entity must not be substituted. If authorized evidence only supports a related but different
subject, Iris must state that the requested fact is unavailable and must not return the related
value.

## Boundaries

- Do not change retrieval ranking, source-type scope, context anchoring, or permission-guard logic.
- Denied fragments remain absent from model context; the prompt must not reveal their content or IDs.
- Direct, generative, formatting, translation, rewriting, and summarization tasks remain available
  without company evidence.
- Do not attempt to control Feishu client's own related-knowledge UI from Iris's plain-text reply.
- Keep Iris globally disabled until the focused regression, full verification, candidate smoke, and
  repeated live permission-denial smoke all pass.

## Verification

1. A focused provider contract test must fail before implementation and prove the exact-subject,
   no-substitution, and unavailable-result policy is present in the system message.
2. Existing task/evidence, output-format, transformation, and safety tests must remain green.
3. Full `npm run verify` must pass.
4. With the knowledge-base document revoked and the similarly named group document still allowed,
   the real Gemini answer must contain neither acceptance marker and must indicate unavailability.
5. After access is restored, the same question must again return `IRIS_WIKI_6158`.
