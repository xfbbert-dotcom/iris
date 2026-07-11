# Iris Current-Group Document Retrieval Scope Design

## Problem

In production `source-policy` mode, Iris currently treats a group-visible document as answerable
when any enabled group appears in the source's origin or evidence. The answer request's current
`chatId` is not part of either the pgvector query or the TypeScript source-policy check.

This allows a question in group A to retrieve a document that Iris observed only in group B. It
also lets out-of-scope fragments consume the bounded vector candidate window before the later
permission guard runs. Both behaviors conflict with the architecture whitepaper: group-visible
documents belong to the current group's retrieval scope unless an explicit cross-group grant
exists.

## Decision

Apply current-group scoping as defense in depth whenever answer drafting runs in production
`source-policy` mode.

1. The answer runtime passes the normalized current `chatId` into document retrieval.
2. Postgres removes out-of-scope group-visible sources before pgvector ranking. A group-visible
   source is eligible only when its `origin_group_id` or one `document_source_evidence.group_id`
   equals the current group.
3. Authorized wiki and user-submitted sources remain company-level under their existing policies;
   the group predicate does not restrict them.
4. The TypeScript source-policy guard independently requires the same exact current-group
   evidence before prompt assembly.
5. If a source-policy answer request has no usable `chatId`, group-visible documents are excluded
   from the requested source types. The request may still use authorized wiki and user-submitted
   sources when their existing runtime capabilities allow them.
6. The current group must also pass the existing document-reading and group-processing runtime
   gates. An enabled but different group never authorizes the source.
7. Development-only `allow-indexed` mode preserves its current unrestricted indexed-source
   behavior. Internal rollout readiness already rejects this mode for production.

The repository's group scope remains optional so non-answering maintenance callers keep their
existing behavior. Production answer retrieval supplies it per request.

## SQL Shape

When a current group is supplied, vector candidates add this predicate before joining the
embedding table and before ordering by distance:

```sql
and (
  ds.source_type <> 'group_visible_document'
  or ds.origin_group_id = $N
  or exists (
    select 1
    from document_source_evidence evidence
    where evidence.document_source_id = ds.id
      and evidence.group_id = $N
  )
)
```

The parameter index is built from the query values array rather than hard-coded so source-type and
group filters can be used independently or together.

## Alternatives Rejected

### TypeScript post-filter only

This would prevent prompt injection but still allow cross-group fragments to crowd out eligible
current-group results inside the bounded vector window.

### SQL filter only

This improves ranking and reduces exposure, but it turns a retrieval optimization into the sole
authorization boundary. The existing source-policy guard should remain independently fail-closed.

### Treat any enabled evidence group as authorization

That is the current bug. Runtime enablement says Iris may operate in a group; it does not grant
that group's documents to every other group.

## Evolution

Future cross-group sharing must introduce explicit grant evidence and update both SQL candidate
selection and the TypeScript policy guard. It must not infer a grant from another enabled group or
from missing group evidence.

## Quality Bar

- A group-A answer cannot retrieve or inject a document observed only in group B.
- A document observed in both groups is eligible in either matching group.
- Out-of-scope fragments cannot consume vector candidate slots.
- Missing current-group scope fails closed for group-visible sources in `source-policy` mode.
- Authorized wiki and user-submitted retrieval behavior remains unchanged.
- Focused and full verification pass, including Postgres integration coverage in CI.
