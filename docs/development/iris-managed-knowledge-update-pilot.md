# Managed Knowledge Existing-Page Update — Controlled Feishu Pilot

## Status and boundary

**Local status:** implemented and locally verified.  The deployment default is
`IRIS_MANAGED_KNOWLEDGE_UPDATE_ENABLED=false` with an empty
`IRIS_MANAGED_KNOWLEDGE_UPDATE_GROUP_ALLOWLIST`.

**Live result:** **not yet run**.  Controlled Feishu acceptance is pending.  Local test success,
an enabled process, or a green readiness check is not proof that the existing-page update loop is
delivered or deployed.

Run this only with written authority for one pilot group, one fresh Iris-created managed page, and
the required private credentials.  It deliberately covers only one newly created, single plain-text
managed block.  Never infer/adopt a legacy page, arbitrary document, multi-block page, or rich
content page.  Do not paste a document body, document/block/access/client token, credential, or
raw Feishu error into a shell, log, ticket, or evidence record.

## Pilot record (complete before enabling)

| Field | Required value |
| --- | --- |
| Pilot authority / change ticket | `pending` |
| Operator and independent approver | `pending` |
| Start and finish timestamps (UTC) | `pending` |
| Immutable deployed image digest, tag, and source SHA | `pending` |
| One allowlisted pilot group ID | `pending` |
| Fresh managed page ID and safe Wiki URL | `pending` |
| Control managed page ID and safe Wiki URL | `pending` |
| Arbitrary unmanaged control page safe Wiki URL | `pending` |
| Live result | `not yet run` |

All evidence below is content-free: IDs, safe Wiki URLs, hashes, revisions, versions, states,
reason codes, timestamps, and redacted counts only.

## Preconditions — stop unless every item passes

1. Keep the feature disabled while preparing the pilot.  Confirm the private deployment file has
   exactly these initial values:

   ```text
   IRIS_MANAGED_KNOWLEDGE_UPDATE_ENABLED=false
   IRIS_MANAGED_KNOWLEDGE_UPDATE_GROUP_ALLOWLIST=
   ```

   Expected evidence: private configuration review records the two values without printing secrets.
   Stop if either value is malformed, a second group appears, or an existing deployment is already
   enabled.

2. Confirm the pilot has a private Feishu write credential, OAuth review configuration, internal
   operator authorization, and a deployed image whose immutable digest/tag maps to the recorded
   source SHA.  Run migrations through `0055_managed_update_execution_identity.sql` before any
   enablement.  Stop if a credential, OAuth approval path, image/SHA mapping, or migration proof is
   absent; do not substitute a local credential or moving image tag.

3. Select exactly three pages in the approved Wiki space:

   - one **fresh Iris-created** page containing exactly one managed plain-text block (pilot target);
   - one separate fresh managed page as a no-change control; and
   - one arbitrary unmanaged page as a no-change control.

   Record IDs and safe Wiki URLs only.  Stop if the target was not created after managed-page capture
   was deployed, has a legacy/inferred identity, has more than one managed block, or contains rich
   content.

4. Before enabling, run the local repository gate from the reviewed source checkout:

   ```powershell
   npm run verify
   ```

   Expected evidence: exit `0`; any configured environment skips are recorded as skips, not as
   PostgreSQL execution.  Stop on a failure.  This command neither deploys nor enables Feishu writes.

5. With the actual deployed private environment (never echo it), use the internal readiness endpoint
   and status endpoint.  The managed-update readiness entry must pass only after all of these are
   true: migration 0055; Feishu write/OAuth dependencies; document-sync worker; approval-action
   worker; knowledge-card runtime; action-review runtime; managed-update worker; one-group allowlist;
   and zero `outcomeUnknown` / `reconciliationRequired` counts.

   ```powershell
   $irisHeaders = @{ authorization = "Bearer $env:IRIS_INTERNAL_API_TOKEN"; "x-iris-operator" = "managed-update-pilot" }
   $readiness = Invoke-RestMethod -Headers $irisHeaders -Uri http://localhost:3000/internal/readiness
   $status = Invoke-RestMethod -Headers $irisHeaders -Uri http://localhost:3000/internal/status
   $managedGate = @($readiness.checks | Where-Object { $_.id -eq "managedKnowledgeUpdates" })
   if ($readiness.ok -ne $true -or $managedGate.Count -ne 1 -or $managedGate[0].status -ne "pass") { throw "Managed-update readiness is not green" }
   if ($status.managedKnowledgeUpdates.reconciliation.outcomeUnknown -ne 0 -or $status.managedKnowledgeUpdates.reconciliation.reconciliationRequired -ne 0) { throw "Unresolved managed updates block the pilot" }
   ```

   Expected evidence: green readiness plus only component states and zero counts.  Stop for missing
   status, a non-pass, nonzero queue/DLQ/unresolved count, or any unexpected content-bearing field.

6. Enable only after all preconditions pass: set the feature flag to `true` and the allowlist to the
   one approved group ID, redeploy the recorded immutable image, recheck readiness, then durably set
   only that group's runtime control and the required `writeKnowledgeBase` and
   `updateManagedKnowledge` capabilities to `true`.  Record durable acknowledgements and reread
   runtime state.  Stop if any other group is enabled, if readiness changes from pass, or if the
   allowlist is not exactly one ID.

   Disabling the feature blocks **new claims** only.  It must not stop recovery/admin reconciliation;
   any existing `outcome_unknown`, reconciliation, or exact resync work must converge to zero before
   closing the pilot dependency.

## One-page acceptance procedure

For every numbered step, stop immediately on a failed expectation, preserve content-free durable
facts, disable new claims as described in rollback, and ask the authorized operator to reconcile.

1. **Fresh publication and capture.** Publish the fresh pilot target through the existing governed
   publication loop.  Capture a metadata-only managed-page record: page/node/document/block IDs,
   positive document revision, canonical body hash, policy version, and active state.  Expected:
   exact single-block identity is present.  Stop if any identity is missing, non-positive, inferred,
   or points at the control pages.

2. **Source sync and link.** Let document sync index the target, then record source ID, snapshot ID,
   snapshot revision/hash, and the exact page/source link.  Expected: the target is the only linked
   source and is retrievable while `active`.  Stop if source identity is ambiguous, source permissions
   fail, or sync/index queues or DLQs are nonzero.

3. **Controlled conflict.** In the allowlisted group, create the approved conflicting source and
   trigger conflict detection.  Expected: one update-bound draft references the target's immutable
   page/source/snapshot/policy tuple; no control page gains a target.  Stop if the system falls back
   to an unbound publication because target resolution is indeterminate.

4. **Group confirmation gate.** Inspect metadata-only proposal/draft facts before the group confirms.
   Expected: no action proposal exists.  Confirm the exact current draft in the pilot group.  Expected
   afterward: exactly one `update_knowledge_publication` proposal, never a
   `publish_knowledge_draft` proposal, with the target fingerprint/version recorded.  Stop on a stale
   card, more than one proposal, a publication proposal, or a changed target fingerprint.

5. **OAuth full-text review and approval.** An eligible owner/admin opens the OAuth review and
   approves the exact current proposal.  Expected: an append-only review attestation and approval
   bind the proposal version, target fingerprint, revision, and hash.  Record only IDs/versions/hashes
   and reviewer role; do not save the review text.  Stop if OAuth, membership/role recheck, approval,
   or attestation is stale/unavailable.

6. **Freshness barrier and exact mutation.** Before mutation, observe the target page transition out
   of `active` and verify retrieval is barred.  Expected: one durable execution claim and one exact
   Feishu mutation of the captured plain-text block; the resulting revision is strictly greater than
   the captured revision; neighbor block count/IDs/types/hashes are unchanged.  Stop if a second
   request appears, the wrong block/page changes, revision does not advance, or any neighbor changes.

7. **Resync and reactivation.** Keep the retrieval barrier in place until document sync produces the
   exact expected source/snapshot/block/revision/hash tuple and durable resync completes.  Expected:
   only then does the page return to `active`, and a permitted retrieval proves the new indexed content
   after reactivation.  Record retrieval result IDs/hash/version only.  Stop if retrieval returns new
   content before reactivation, if a mismatched snapshot reactivates the page, or if status remains
   `outcome_unknown` / `reconciliation_required`.

8. **Control pages and drain.** Re-read metadata for the managed control and arbitrary unmanaged
   control.  Expected: their revisions, block structures, hashes, and state are unchanged.  Check
   managed-update, document-sync, action-approval, event, and reindex queues/DLQs; expected all
   pending/processing/delayed/DLQ/unresolved counts are zero.  Stop on any control-page change or
   nonzero unresolved count.

## Rollback and closeout

On completion or any stop condition, first set
`IRIS_MANAGED_KNOWLEDGE_UPDATE_ENABLED=false` and empty the allowlist, then redeploy the same
recorded image configuration.  Durably disable the pilot group and the `updateManagedKnowledge`
capability; leave recovery/admin reconciliation available.  Recheck that new claims are blocked,
existing resync/reconciliation continues, and all unresolved/DLQ counts reach zero.  Do not delete
facts, messages, queues, migrations, or history to make the pilot appear clean.

The acceptance may be marked **passed** only after this document's pilot record contains the real
immutable image/tag/SHA, timestamps, operators, safe Wiki URLs, and content-free durable evidence
for every step.  Until then its result remains **not yet run / controlled Feishu acceptance pending**.
