import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { runInNewContext } from "node:vm";

const backupPath = "deploy/pilot/backup.sh";
const restorePath = "deploy/pilot/restore-from-stdin.sh";
const semanticRecoveryProbePath = "deploy/pilot/semantic-recovery-probe.sh";
const semanticOrderedReplayPath = "deploy/pilot/semantic-dlq-replay-one-by-one.sh";
const semanticAcceptanceInspectPath = "deploy/pilot/semantic-acceptance-inspect.sh";
const semanticSeedFromMessagesPath = "deploy/pilot/semantic-seed-from-messages.sh";
const semanticReseedFromMessagesPath = "deploy/pilot/semantic-reseed-from-messages-one-by-one.sh";
const semanticFreshAcceptancePath = "deploy/pilot/semantic-fresh-acceptance-one-by-one.sh";
const proactiveFeedbackAutoclosePath = "deploy/pilot/proactive-feedback-autoclose.sh";
const postgresInitPath = "deploy/pilot/postgres-init.sh";
const pilotReadmePath = "deploy/pilot/README.md";
const ciWorkflowPath = ".github/workflows/ci.yml";
const knowledgeConflictAcceptancePath =
  "docs/runbooks/iris-knowledge-conflict-acceptance.md";
const knowledgeConflictPrPath =
  "docs/pull-requests/2026-08-13-iris-knowledge-conflict-candidate.md";
const crossGroupGrantAcceptancePath =
  "docs/runbooks/iris-cross-group-document-grants-acceptance.md";
const crossGroupGrantPrPath =
  "docs/pull-requests/2026-08-18-iris-cross-group-document-grants.md";

test("cross-group document grant acceptance is executable and default-deny", () => {
  assert.equal(existsSync(crossGroupGrantAcceptancePath), true);
  const runbook = readFileSync(crossGroupGrantAcceptancePath, "utf8");
  for (let step = 1; step <= 8; step += 1) {
    assert.match(runbook, new RegExp(`## Step ${step}:`, "u"), `missing grant step ${step}`);
  }
  for (const marker of [
    "APPROVED_COMMIT_SHA",
    "IRIS_APPROVED_IMAGE_DIGEST",
    "$SourceGroupId",
    "$GranteeGroupId",
    "$ControlGroupId",
    "0051_document_source_group_grants.sql",
    "pre-grant denial",
    "answer_reply_source_traces",
    "permission_blocked",
    "begin-send/revoke",
    "Invoke-CrossGroupDocumentGrantAcceptance",
    "Invoke-CrossGroupDocumentGrantRollback",
  ]) {
    assert.match(runbook, new RegExp(escapeRegExp(marker), "iu"));
  }
  const rollbackStart = runbook.indexOf("function Invoke-CrossGroupDocumentGrantRollback");
  const acceptanceStart = runbook.indexOf("function Invoke-CrossGroupDocumentGrantAcceptance");
  assert.ok(rollbackStart >= 0 && acceptanceStart > rollbackStart);
  const rollback = runbook.slice(rollbackStart, acceptanceStart);
  assertMarkersInOrder(rollback, [
    "stop caddy",
    "/group-grants/",
    "/internal/runtime-control/groups/",
    "/internal/runtime-control/global",
    "/internal/runtime-control/capabilities",
    "Wait-CrossGroupDrain",
    "Assert-CrossGroupRollbackAttestation",
  ]);
  assert.doesNotMatch(rollback, /\b(?:DELETE|TRUNCATE|DROP)\b/iu);
  const acceptance = runbook.slice(acceptanceStart);
  assertMarkersInOrder(acceptance, [
    "Invoke-Compose @(\"stop\", \"caddy\")",
    "Assert-ReviewedBuild $context",
    "./deploy/pilot/backup.sh",
    "$enableAttempted = $true",
    "Get-KnownGroupIds $context",
    "preflight group disable",
  ]);
  assert.match(acceptance, /finally\s*\{[\s\S]*Invoke-CrossGroupDocumentGrantRollback/u);
  assert.match(runbook, /function Wait-CrossGroupDrain[\s\S]*Attempts = 60[\s\S]*DelayMilliseconds = 500/iu);
  assert.match(runbook, /gh run view[\s\S]*headSha[\s\S]*Test Postgres integrations/iu);
  assert.match(runbook, /docker image inspect[\s\S]*ApprovedImageDigest/iu);
  assert.match(runbook, /Invoke-JsonSql/u);
  assert.match(runbook, /Get-FreshCrossGroupEvidence/u);
  assert.doesNotMatch(runbook, /\$artifact\.facts/iu);
});

test("cross-group document grant source binding accepts live-checked unknown permission", () => {
  const runbook = readFileSync(crossGroupGrantAcceptancePath, "utf8");
  const sourceBindingStart = runbook.indexOf("function Assert-SourceBinding");
  const denialStageStart = runbook.indexOf("function Assert-DenialStage", sourceBindingStart);
  assert.ok(sourceBindingStart >= 0 && denialStageStart > sourceBindingStart);
  const sourceBinding = runbook.slice(sourceBindingStart, denialStageStart);

  assert.match(sourceBinding, /permission_state\s+IN\s*\(\s*'unknown'\s*,\s*'readable'\s*\)/iu);
  assert.doesNotMatch(sourceBinding, /permission_state\s*=\s*'readable'/iu);
  assert.match(sourceBinding, /source_type='group_visible_document'/u);
  assert.match(sourceBinding, /sync_state='synced'/u);
  assert.match(sourceBinding, /can_use_for_answering=TRUE/u);
});

test("cross-group ingress window preserves the live runtime activation", () => {
  const valid = {
    runtime: {
      ok: true,
      globalEnabled: true,
      desiredGlobalEnabled: true,
      activationRequired: false,
      disabledGroupIds: ["oc_other"],
      capabilities: {
        readGroupContext: true,
        replyWhenMentioned: true,
        readGroupDocuments: true,
        retrieveKnowledgeBase: true,
        proactiveSpeech: false,
        generateKnowledgeDrafts: false,
        writeKnowledgeBase: false,
        callExternalTools: false,
      },
      persistence: { storage: "postgres", ok: true },
    },
  };
  const contextCommand = [
    "$context = [pscustomobject]@{ SourceGroupId='oc_source'; GranteeGroupId='oc_grantee'; ControlGroupId='oc_control' }",
    "$known = @('oc_source','oc_grantee','oc_control','oc_other')",
  ];
  const startCommand = [
    ...contextCommand,
    "$script:composeCalls = @()",
    "function Invoke-Compose { param([string[]]$Arguments) $script:composeCalls += ,@($Arguments); if ($Arguments -notcontains '--no-deps') { $inputValue.runtime.globalEnabled = $false; $inputValue.runtime.activationRequired = $true } }",
    "function Invoke-CoreJson { param([string]$Method, [string]$Path, [object]$Body) return $inputValue.runtime }",
    "Start-CrossGroupIngressWindow -Context $context -KnownGroupIds $known",
    "if ($script:composeCalls.Count -ne 1 -or ($script:composeCalls[0] -join ' ') -cne 'up --detach --wait --wait-timeout 120 --no-deps caddy') { throw 'ingress window did not isolate Caddy startup' }",
  ].join("; ");
  assertPowerShellRunbookGate(startCommand, structuredClone(valid), true, crossGroupGrantAcceptancePath);

  const activationCommand = [
    ...contextCommand,
    "Assert-CrossGroupLiveActivation -Runtime $inputValue.runtime -Context $context -KnownGroupIds $known",
  ].join("; ");
  for (const invalidRuntime of [
    { ...valid.runtime, globalEnabled: false, activationRequired: true },
    { ...valid.runtime, desiredGlobalEnabled: false },
    { ...valid.runtime, activationRequired: true },
    { ...valid.runtime, disabledGroupIds: ["oc_grantee", "oc_other"] },
    { ...valid.runtime, disabledGroupIds: [] },
    { ...valid.runtime, capabilities: { ...valid.runtime.capabilities, readGroupContext: false } },
    { ...valid.runtime, capabilities: { ...valid.runtime.capabilities, replyWhenMentioned: false } },
    { ...valid.runtime, capabilities: { ...valid.runtime.capabilities, readGroupDocuments: false } },
    { ...valid.runtime, capabilities: { ...valid.runtime.capabilities, retrieveKnowledgeBase: false } },
    { ...valid.runtime, persistence: { storage: "postgres", ok: false } },
  ]) {
    assertPowerShellRunbookGate(
      activationCommand,
      { runtime: invalidRuntime },
      false,
      crossGroupGrantAcceptancePath,
    );
  }
});

test("cross-group stage evidence uses provider message IDs and rollback closes every read gate", () => {
  const runbook = readFileSync(crossGroupGrantAcceptancePath, "utf8");
  const denialStart = runbook.indexOf("function Assert-DenialStage");
  const projectionStart = runbook.indexOf("function Assert-GrantProjection", denialStart);
  const grantedStart = runbook.indexOf("function Assert-GrantedAnswerStage", projectionStart);
  const fingerprintStart = runbook.indexOf("function Get-CrossGroupMutableFingerprint", grantedStart);
  const rollbackStart = runbook.indexOf("function Invoke-CrossGroupDocumentGrantRollback");
  const acceptanceStart = runbook.indexOf("function Invoke-CrossGroupDocumentGrantAcceptance", rollbackStart);
  assert.ok(
    denialStart >= 0 && projectionStart > denialStart && grantedStart > projectionStart &&
      fingerprintStart > grantedStart && rollbackStart > fingerprintStart && acceptanceStart > rollbackStart,
  );

  for (const stage of [
    runbook.slice(denialStart, projectionStart),
    runbook.slice(grantedStart, fingerprintStart),
  ]) {
    assert.match(stage, /conversation_messages\s+WHERE\s+provider_message_id='\$granteeMessage'/u);
    assert.match(stage, /conversation_messages\s+WHERE\s+provider_message_id='\$controlMessage'/u);
    assert.doesNotMatch(stage, /conversation_messages\s+WHERE\s+id='\$(?:grantee|control)Message'/u);
  }

  const rollback = runbook.slice(rollbackStart, acceptanceStart);
  const acceptance = runbook.slice(acceptanceStart);
  assert.match(rollback, /readGroupContext\s*=\s*\$false/u);
  assert.match(
    acceptance,
    /"PATCH"\s+"\/internal\/runtime-control\/capabilities"\s+@\{\s*readGroupContext\s*=\s*\$false;?\s*replyWhenMentioned\s*=\s*\$false/u,
  );
  assert.match(
    acceptance,
    /"PATCH"\s+"\/internal\/runtime-control\/capabilities"\s+@\{\s*readGroupContext\s*=\s*\$true\s+replyWhenMentioned\s*=\s*\$true/u,
  );
  assert.match(runbook, /throw \("rollback failed: " \+ \(\$script:RollbackErrors -join "; "\)\)/u);
});

test("cross-group document grant CI executes real migration and concurrency coverage", () => {
  const workflow = readFileSync(ciWorkflowPath, "utf8");
  for (const testFile of [
    "migration-runner.test.ts",
    "postgres-document-source-group-grant-repository.test.ts",
    "postgres-answer-reply-repository.test.ts",
  ]) {
    assert.match(workflow, new RegExp(escapeRegExp(testFile), "u"));
  }
});

test("cross-group document grant evidence is exact-SHA, image, stage, and time bound", () => {
  const commitSha = "a".repeat(40);
  const imageDigest = `sha256:${"b".repeat(64)}`;
  const valid = {
    stage: "preGrant",
    recordedAt: "2026-08-18T02:00:01.000Z",
    approvedCommitSha: commitSha,
    approvedImageDigest: imageDigest,
    observations: {
      granteeIncomingMessageId: "om_grantee_pregrant",
      controlIncomingMessageId: "om_control_pregrant",
      granteeDisclosedSource: false,
      controlDisclosedSource: false,
    },
  };
  const command = [
    "$notBefore = [DateTimeOffset]'2026-08-18T02:00:00.000Z'",
    "$notAfter = [DateTimeOffset]'2026-08-18T02:01:00.000Z'",
    `Assert-FreshCrossGroupEvidence -Evidence $inputValue -ExpectedStage 'preGrant' -ExpectedCommitSha '${commitSha}' -ExpectedImageDigest '${imageDigest}' -NotBefore $notBefore -NotAfter $notAfter`,
  ].join("; ");
  assertPowerShellRunbookGate(command, valid, true, crossGroupGrantAcceptancePath);
  for (const invalid of [
    { ...valid, stage: "granted" },
    { ...valid, recordedAt: "2026-08-18T01:59:59.000Z" },
    { ...valid, recordedAt: "2026-08-18T02:01:01.000Z" },
    { ...valid, approvedCommitSha: "c".repeat(40) },
    { ...valid, approvedImageDigest: `sha256:${"d".repeat(64)}` },
    { ...valid, observations: { ...valid.observations, nested: { replyText: "forbidden" } } },
  ]) {
    assertPowerShellRunbookGate(command, invalid, false, crossGroupGrantAcceptancePath);
  }
});

test("cross-group document grant gates reject false-positive facts", () => {
  const valid = {
    preGrant: { granteeTraceCount: 0, controlTraceCount: 0, promptGrantCount: 0 },
    grant: { state: "active", version: 1, grantedEventCount: 1 },
    grantee: { deliveryCount: 1, traceCount: 1, exactGrantBindingCount: 1 },
    control: { traceCount: 0, sourceDisclosureCount: 0 },
    revocation: { preparedCount: 1, permissionBlockedCount: 1, sendStartedCount: 0, sentCount: 0 },
    regrant: { version: 3, grantedEventCount: 1, replayEventDelta: 0, deliveryCount: 1 },
    race: { safeOutcomeCount: 1, sendAfterRevokeCount: 0 },
  };
  const command = "Assert-CrossGroupGrantFacts -Facts $inputValue";
  assertPowerShellRunbookGate(command, valid, true, crossGroupGrantAcceptancePath);
  for (const invalid of [
    { ...valid, preGrant: { ...valid.preGrant, granteeTraceCount: 1 } },
    { ...valid, grant: { ...valid.grant, grantedEventCount: 2 } },
    { ...valid, grantee: { ...valid.grantee, exactGrantBindingCount: 0 } },
    { ...valid, control: { ...valid.control, sourceDisclosureCount: 1 } },
    { ...valid, revocation: { ...valid.revocation, sendStartedCount: 1 } },
    { ...valid, regrant: { ...valid.regrant, replayEventDelta: 1 } },
    { ...valid, race: { ...valid.race, sendAfterRevokeCount: 1 } },
  ]) {
    assertPowerShellRunbookGate(command, invalid, false, crossGroupGrantAcceptancePath);
  }
});

test("cross-group document grant rollback rejects residual or lost durable facts", () => {
  const valid = {
    caddyRunning: false,
    globalEnabled: false,
    desiredGlobalEnabled: false,
    capabilitiesDisabled: true,
    disabledGroupCount: 3,
    activePilotGrantCount: 0,
    pendingCount: 0,
    deadLetterCount: 0,
    unresolvedDeliveryCount: 0,
    mutableFingerprintBefore: "a".repeat(64),
    mutableFingerprintAfter: "a".repeat(64),
    appendOnlyEventCountBefore: 2,
    appendOnlyEventCountAfter: 2,
  };
  const command = "Assert-CrossGroupRollbackAttestation -Facts $inputValue";
  assertPowerShellRunbookGate(command, valid, true, crossGroupGrantAcceptancePath);
  for (const invalid of [
    { ...valid, caddyRunning: true },
    { ...valid, capabilitiesDisabled: false },
    { ...valid, activePilotGrantCount: 1 },
    { ...valid, unresolvedDeliveryCount: 1 },
    { ...valid, mutableFingerprintAfter: "b".repeat(64) },
    { ...valid, appendOnlyEventCountAfter: 1 },
  ]) {
    assertPowerShellRunbookGate(command, invalid, false, crossGroupGrantAcceptancePath);
  }
});

test("cross-group document grant PR remains pending and metadata-only", () => {
  assert.equal(existsSync(crossGroupGrantPrPath), true);
  const template = readFileSync(crossGroupGrantPrPath, "utf8");
  assert.match(template, /## Release Status\s+Pending live acceptance/iu);
  assert.match(template, /首个跨群文档回答闭环代码完成，真实验收待执行/u);
  for (const marker of ["IDs", "versions", "hashes", "counts", "timestamps", "pass/fail", "default-deny", "rollback"]) {
    assert.match(template, new RegExp(escapeRegExp(marker), "iu"));
  }
  assert.doesNotMatch(template, /document body|answer body|message body|access token|credential value/iu);
});

test("pilot operation scripts are valid Bash", { skip: bashPath() === undefined }, () => {
  for (const scriptPath of [
    backupPath,
    restorePath,
    semanticRecoveryProbePath,
    semanticOrderedReplayPath,
    semanticAcceptanceInspectPath,
    semanticSeedFromMessagesPath,
    semanticReseedFromMessagesPath,
    proactiveFeedbackAutoclosePath,
    postgresInitPath,
  ]) {
    const result = spawnSync(bashPath(), ["-n", scriptPath], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr || result.stdout);
  }
});

test("knowledge-conflict acceptance runbook is executable and covers all twelve gates", () => {
  assert.equal(existsSync(knowledgeConflictAcceptancePath), true);
  const runbook = readFileSync(knowledgeConflictAcceptancePath, "utf8");
  for (let step = 1; step <= 12; step += 1) {
    assert.match(runbook, new RegExp(`## Step ${step}:`, "u"), `missing acceptance step ${step}`);
  }
  for (const marker of [
    "APPROVED_COMMIT_SHA",
    "IRIS_APPROVED_IMAGE_DIGEST",
    "$PilotGroupId",
    "$ControlGroupIds",
    "knowledge_conflict",
    "medium",
    "governed update draft",
    "does not edit the existing Wiki page in place",
    "Invoke-KnowledgeConflictAcceptance",
  ]) {
    assert.match(runbook, new RegExp(escapeRegExp(marker), "u"));
  }
  assert.doesNotMatch(runbook, /https:\/\/[^\s`]*(?:wiki|docx)[^\s`]*/iu);
});

test("knowledge-conflict clean-worktree gate is safe under strict PowerShell mode", () => {
  const runbook = readFileSync(knowledgeConflictAcceptancePath, "utf8");
  assert.match(
    runbook,
    /if \(@\(git status --porcelain --untracked-files=all\)\.Count -ne 0\) \{ throw "Reviewed checkout is not clean" \}/u,
  );
});

test("knowledge-conflict rollback is unconditional after enablement and preserves facts", () => {
  assert.equal(existsSync(knowledgeConflictAcceptancePath), true);
  const runbook = readFileSync(knowledgeConflictAcceptancePath, "utf8");
  const rollbackStart = runbook.indexOf("function Invoke-KnowledgeConflictRollback");
  const rollbackEnd = runbook.indexOf("function Invoke-KnowledgeConflictAcceptance", rollbackStart);
  assert.ok(rollbackStart >= 0 && rollbackEnd > rollbackStart, "rollback helper must be executable");
  const rollback = runbook.slice(rollbackStart, rollbackEnd);
  assertMarkersInOrder(rollback, [
    "stop caddy",
    "IRIS_KNOWLEDGE_CONFLICT_ENABLED=false",
    "IRIS_KNOWLEDGE_CONFLICT_GROUP_ALLOWLIST=",
    "/internal/runtime-control/groups/",
    "/internal/runtime-control/global",
    "/internal/runtime-control/capabilities",
    "--force-recreate --wait --wait-timeout 120 core",
    "Get-DurableActivityFingerprint",
    "Assert-FingerprintUnchanged",
    "Assert-CountsUnchanged",
    "Assert-AppendOnlyFactsPreserved",
  ]);
  assert.doesNotMatch(rollback, /\b(?:DELETE|TRUNCATE|DROP)\b/iu);

  const wrapper = runbook.slice(rollbackEnd);
  assert.match(wrapper, /\$EnableAttempted\s*=\s*\$true/u);
  assert.match(wrapper, /try\s*\{/u);
  assert.match(wrapper, /finally\s*\{[\s\S]*Invoke-KnowledgeConflictRollback/u);
});

test("knowledge-conflict enabled readiness tolerates bounded startup convergence", () => {
  assertPowerShellRunbookGate(
    `
$script:readinessAttempt = 0
function Start-Sleep { param([int]$Milliseconds) }
function Invoke-RestMethod {
  param([hashtable]$Headers, [string]$Uri)
  if ($Uri -like '*/internal/readiness') {
    $script:readinessAttempt += 1
    return @{ ok = ($script:readinessAttempt -ge 2) }
  }
  if ($Uri -like '*/internal/status') {
    return @{ status = 'healthy'; components = @{ knowledgeConflicts = @{ running = ($script:readinessAttempt -ge 2) } } }
  }
  if ($Uri -like '*/internal/runtime-control/status') {
    return @{ globalEnabled = $true; desiredGlobalEnabled = $true; disabledGroupIds = @('control-group') }
  }
  throw "unexpected URI"
}
$result = Wait-EnabledConflictRuntimeReady -Headers @{} -PilotGroupId 'pilot-group' -NonPilotGroupIds @('control-group') -MaxAttempts 3 -PollIntervalMilliseconds 1
if ($script:readinessAttempt -ne 2 -or $result.status.components.knowledgeConflicts.running -ne $true) { throw 'bounded readiness did not converge' }
`,
    {},
    true,
  );

  const runbook = readFileSync(knowledgeConflictAcceptancePath, "utf8");
  assert.match(runbook, /Wait-EnabledConflictRuntimeReady[\s\S]*-MaxAttempts 60[\s\S]*-PollIntervalMilliseconds 500/u);
  assert.doesNotMatch(
    runbook,
    /\$enabledReadiness\s*=\s*Invoke-RestMethod[\s\S]{0,500}Enabled conflict runtime is not ready/u,
  );
});

test("knowledge-conflict PR evidence records metadata-only live acceptance and default-off rollback", () => {
  assert.equal(existsSync(knowledgeConflictPrPath), true);
  const template = readFileSync(knowledgeConflictPrPath, "utf8");
  assert.match(template, /## Release Status\s+Live acceptance passed/iu);
  for (const marker of [
    "exact commit SHA",
    "image digest",
    "IDs",
    "versions",
    "hashes",
    "counts",
    "timestamps",
    "pass/fail",
    "governed update draft",
    "does not edit the existing Wiki page in place",
    "default-off",
    "rollback",
  ]) {
    assert.match(template, new RegExp(escapeRegExp(marker), "iu"));
  }
  assert.doesNotMatch(template, /message body|document body|credential value|access token/iu);
});

test("knowledge-conflict exact evidence gate rejects duplicate and unrelated rows", () => {
  const snapshotHash = "0".repeat(64);
  const fragmentHash = "1".repeat(64);
  const row = (overrides) => ({
    evidenceType: "conversation_message",
    referenceId: "C1",
    groupId: null,
    conversationMessageId: null,
    groupMemoryId: null,
    sourceUpdatedAt: null,
    documentSourceId: null,
    documentSnapshotId: null,
    documentFragmentId: null,
    snapshotContentHash: null,
    contentHash: null,
    ...overrides,
  });
  const exactEvidence = {
    pilotMessageIds: ["message_id"],
    memoryId: "memory_id",
    memoryUpdatedAt: "2026-08-15T01:02:03.000Z",
    documentSourceId: "source_id",
    documentSourceUpdatedAt: "2026-08-15T01:02:02.000Z",
    snapshotId: "snapshot_id",
    contentHash: snapshotHash,
    documentFragments: [{ referenceId: "D1", id: "fragment_id", contentHash: fragmentHash }],
    exactEvidenceRows: [
      row({ groupId: "pilot_group", conversationMessageId: "message_id" }),
      row({
        evidenceType: "group_memory",
        referenceId: "M1",
        groupId: "pilot_group",
        groupMemoryId: "memory_id",
        sourceUpdatedAt: "2026-08-15T01:02:03.000Z",
      }),
      row({
        evidenceType: "document_source",
        referenceId: "D1",
        documentSourceId: "source_id",
        sourceUpdatedAt: "2026-08-15T01:02:02.000Z",
      }),
      row({
        evidenceType: "document_snapshot",
        referenceId: "D1",
        documentSourceId: "source_id",
        documentSnapshotId: "snapshot_id",
        snapshotContentHash: snapshotHash,
        contentHash: snapshotHash,
      }),
      row({
        evidenceType: "document_fragment",
        referenceId: "D1",
        documentSourceId: "source_id",
        documentSnapshotId: "snapshot_id",
        documentFragmentId: "fragment_id",
        snapshotContentHash: snapshotHash,
        contentHash: fragmentHash,
      }),
    ],
  };
  const rowsCommand = `$rows = @(Get-ExpectedEvidenceSqlRows -Rows @($inputValue.exactEvidenceRows) -Evidence $inputValue -PilotGroupId 'pilot_group'); if ($rows.Count -ne 5 -or @($rows | Where-Object { $_ -notmatch '^\\(.*\\)$' }).Count -ne 0) { throw 'wrong SQL row shape' }`;
  assertPowerShellRunbookGate(rowsCommand, exactEvidence, true);
  assertPowerShellRunbookGate(rowsCommand, {
    ...exactEvidence,
    exactEvidenceRows: [
      ...exactEvidence.exactEvidenceRows,
      exactEvidence.exactEvidenceRows[0],
    ],
  }, false);
  assertPowerShellRunbookGate(rowsCommand, {
    ...exactEvidence,
    exactEvidenceRows: exactEvidence.exactEvidenceRows.map((item, index) =>
      index === 0 ? { ...item, conversationMessageId: "unrelated_message_id" } : item),
  }, false);

  const valid = {
    scanCount: 1,
    candidateCount: 1,
    expectedEvidenceCount: 5,
    actualEvidenceCount: 5,
    missingEvidenceCount: 0,
    unexpectedEvidenceCount: 0,
    duplicateExpectedCount: 0,
  };
  assertPowerShellRunbookGate(
    `Assert-ExactEvidenceBindingFacts -Facts $inputValue`,
    valid,
    true,
  );
  assertPowerShellRunbookGate(
    `Assert-ExactEvidenceBindingFacts -Facts $inputValue`,
    { ...valid, duplicateExpectedCount: 1 },
    false,
  );
  assertPowerShellRunbookGate(
    `Assert-ExactEvidenceBindingFacts -Facts $inputValue`,
    { ...valid, unexpectedEvidenceCount: 1 },
    false,
  );

  const runbook = readFileSync(knowledgeConflictAcceptancePath, "utf8");
  for (const marker of [
    "conversation_message_id",
    "group_memory_id",
    "source_updated_at",
    "document_source_id",
    "document_snapshot_id",
    "document_fragment_id",
    "snapshot_content_hash",
    "content_hash",
    "EXCEPT ALL",
  ]) {
    assert.match(runbook, new RegExp(escapeRegExp(marker), "u"));
  }
});

test("knowledge-conflict chronology proves every exact pilot message is strictly later", () => {
  const valid = {
    sourceSnapshotCount: 1,
    sourceUpdatedAt: "2026-08-15T01:02:03.000Z",
    snapshotFetchedAt: "2026-08-15T01:02:03.500Z",
    messages: [
      {
        id: "message_c1",
        sentAt: "2026-08-15T01:02:04.000Z",
        createdAt: "2026-08-15T01:02:05.000Z",
        rowCount: 1,
        pilotCount: 1,
        strictlyLaterCount: 1,
      },
      {
        id: "message_c2",
        sentAt: "2026-08-15T01:02:04.500Z",
        createdAt: "2026-08-15T01:02:06.000Z",
        rowCount: 1,
        pilotCount: 1,
        strictlyLaterCount: 1,
      },
    ],
  };
  const command = `Assert-MultiMessageChronologyFacts -Facts $inputValue.facts -ExpectedMessageIds @($inputValue.expectedMessageIds)`;
  assertPowerShellRunbookGate(command, {
    facts: valid,
    expectedMessageIds: ["message_c1", "message_c2"],
  }, true);
  assertPowerShellRunbookGate(command, {
    facts: {
      ...valid,
      messages: [
        valid.messages[0],
        {
          ...valid.messages[1],
          sentAt: "2026-08-15T01:02:02.000Z",
          createdAt: "2026-08-15T01:02:06.000Z",
          strictlyLaterCount: 1,
        },
      ],
    },
    expectedMessageIds: ["message_c1", "message_c2"],
  }, false);
  assertPowerShellRunbookGate(command, {
    facts: {
      ...valid,
      messages: [valid.messages[0], { ...valid.messages[1], pilotCount: 0 }],
    },
    expectedMessageIds: ["message_c1", "message_c2"],
  }, false);
  assertPowerShellRunbookGate(command, {
    facts: valid,
    expectedMessageIds: ["message_c1", "message_c1"],
  }, false);
  assertPowerShellRunbookGate(command, {
    facts: { ...valid, messages: valid.messages.slice(0, 1) },
    expectedMessageIds: ["message_c1", "message_c2"],
  }, false);

  const runbook = readFileSync(knowledgeConflictAcceptancePath, "utf8");
  for (const marker of [
    "Assert-MultiMessageChronologyFacts",
    "message.sent_at > source_snapshot.updated_at",
    "message.sent_at > source_snapshot.fetched_at",
    "json_agg",
  ]) {
    assert.match(runbook, new RegExp(escapeRegExp(marker), "u"));
  }
  assert.doesNotMatch(runbook, /message\.created_at\s*>\s*source_snapshot\./u);
});

test("knowledge-conflict source-version binding accepts exact nullable production facts", () => {
  const command = `$actual = ConvertTo-SqlNullableReference -Name 'sourceVersion' -Value $inputValue.value; if ($actual -cne $inputValue.expected) { throw 'unexpected source-version SQL value' }`;
  assertPowerShellRunbookGate(command, { value: null, expected: "NULL::text" }, true);
  assertPowerShellRunbookGate(command, { value: "v123", expected: "'v123'::text" }, true);

  const runbook = readFileSync(knowledgeConflictAcceptancePath, "utf8");
  assert.equal(
    (runbook.match(/source_version IS NOT DISTINCT FROM \$sourceVersionSql/gu) ?? []).length,
    2,
  );
  assert.doesNotMatch(runbook, /source_version\s*=\s*'\$\([^\n]*sourceVersion[^\n]*\)'/u);
  assert.match(runbook, /"sourceVersion": null/u);
});

test("knowledge-conflict approved-card gate rejects false or missing metadata proof", () => {
  const hash = "a".repeat(64);
  const valid = {
    candidateId: "candidate_id",
    deliveryId: "delivery_id",
    messageId: "message_id",
    cardHash: hash,
    currentKnowledgeShown: true,
    newerGroupConclusionShown: true,
    materialDifferenceShown: true,
    proposedUpdateShown: true,
    uncertaintyLabelShown: true,
    currentKnowledgeEvidenceCount: 1,
    newerGroupEvidenceCount: 1,
    safeReadableCurrentLinkCount: 1,
    unsafeOrDeniedLinkCount: 0,
  };
  const command = `Assert-ApprovedCardProof -Proof $inputValue -CandidateId 'candidate_id' -DeliveryId 'delivery_id' -MessageId 'message_id'`;
  assertPowerShellRunbookGate(command, valid, true);
  assertPowerShellRunbookGate(
    command,
    { ...valid, proposedUpdateShown: false },
    false,
  );
  const missingProof = { ...valid };
  delete missingProof.materialDifferenceShown;
  assertPowerShellRunbookGate(command, missingProof, false);
  assertPowerShellRunbookGate(
    command,
    { ...valid, unsafeOrDeniedLinkCount: 1 },
    false,
  );
});

test("knowledge-conflict revocation gate requires six exact stage/cause facts", () => {
  const stages = ["pre_answer", "pre_delivery", "pre_callback"];
  const causes = ["permission", "snapshot"];
  const valid = stages.flatMap((stage) => causes.map((cause) => ({
    stage,
    cause,
    candidateId: `${cause}_${stage}_candidate`,
    operationKey: `${cause}_${stage}_operation`,
    draftId: `${cause}_${stage}_draft`,
    revokedAt: "2026-08-15T01:02:03.000Z",
    exactCandidateCount: 1,
    revocationEventCount: cause === "snapshot" ? 1 : 0,
    operationRejectedCount: 1,
    operationResultCode: cause === "permission"
      ? "permission_blocked"
      : stage === "pre_answer" ? "snapshot_stale"
        : stage === "pre_delivery" ? "stale_candidate" : "evidence_invalidated",
    answerConflictBindingCount: 0,
    answerDisclosureCount: 0,
    deliveryCreatedCount: 0,
    sentMessageCount: 0,
    appliedInteractionCount: 0,
    draftMutationCount: 0,
    callbackRejectedCount: stage === "pre_callback" ? 1 : 0,
    callbackIdentityCount: stage === "pre_callback" ? 1 : 0,
  })));
  assertPowerShellRunbookGate(
    `Assert-RevocationFacts -Facts @($inputValue)`,
    valid,
    true,
  );
  assertPowerShellRunbookGate(
    `Assert-RevocationFacts -Facts @($inputValue)`,
    valid.map((item, index) => index === 0 ? { ...item, sentMessageCount: 1 } : item),
    false,
  );
  assertPowerShellRunbookGate(
    `Assert-RevocationFacts -Facts @($inputValue)`,
    valid.slice(1),
    false,
  );
});

test("knowledge-conflict final drain includes answer and governed-action durable states", () => {
  const valid = {
    answerPrepared: 0,
    answerSending: 0,
    answerReconciliationRequired: 0,
    draftPresentationUnresolved: 0,
    draftPresentationActive: 0,
    draftOutboxUnresolved: 0,
    actionProposalUnresolved: 0,
    actionRequirementPending: 0,
    actionPresentationUnresolved: 0,
    actionPresentationActive: 0,
    actionOutboxUnresolved: 0,
    actionExecutionUnresolved: 0,
    actionExecutionFailed: 4,
    publishedDraftMissingPublication: 0,
    succeededProposalMissingPublication: 0,
    succeededExecutionMissingPublication: 0,
    publicationBindingMismatch: 0,
  };
  assertPowerShellRunbookGate(`Assert-DrainedDurableStates -Counts $inputValue`, valid, true);
  assertPowerShellRunbookGate(
    `Assert-DrainedDurableStates -Counts $inputValue`,
    { ...valid, answerPrepared: 1 },
    false,
  );
  assertPowerShellRunbookGate(
    `Assert-DrainedDurableStates -Counts $inputValue`,
    { ...valid, actionExecutionUnresolved: 1 },
    false,
  );
  assertPowerShellRunbookGate(
    `Assert-DrainedDurableStates -Counts $inputValue`,
    { ...valid, actionRequirementPending: 0, actionPresentationActive: 1 },
    false,
  );
  assertPowerShellRunbookGate(
    `Assert-DrainedDurableStates -Counts $inputValue`,
    { ...valid, draftPresentationActive: 1 },
    false,
  );
  assertPowerShellRunbookGate(
    `Assert-DrainedDurableStates -Counts $inputValue`,
    { ...valid, publishedDraftMissingPublication: 1 },
    false,
  );
  assertPowerShellRunbookGate(
    `Assert-DrainedDurableStates -Counts $inputValue`,
    { ...valid, publicationBindingMismatch: 1 },
    false,
  );
  assertPowerShellRunbookGate(
    `Assert-TerminalGovernedCountsUnchanged -Before $inputValue.before -After $inputValue.after`,
    {
      before: { actionExecutionFailed: 4 },
      after: { actionExecutionFailed: 4 },
    },
    true,
  );
  assertPowerShellRunbookGate(
    `Assert-TerminalGovernedCountsUnchanged -Before $inputValue.before -After $inputValue.after`,
    {
      before: { actionExecutionFailed: 4 },
      after: { actionExecutionFailed: 5 },
    },
    false,
  );

  const runbook = readFileSync(knowledgeConflictAcceptancePath, "utf8");
  for (const marker of [
    "answer_reply_deliveries",
    "knowledge_draft_presentation_outbox",
    "action_proposals",
    "action_approval_requirements",
    "action_approval_presentations",
    "action_approval_presentation_outbox",
    "action_executions",
    "knowledge_publications",
    "publishedDraftMissingPublication",
    "reconciliation_required",
    "outcome_unknown",
  ]) {
    assert.match(runbook, new RegExp(escapeRegExp(marker), "u"));
  }
  assert.match(
    runbook,
    /knowledge_draft_presentation_outbox outbox[\s\S]*JOIN knowledge_draft_presentations presentation[\s\S]*presentation\.state IN \('pending_send','active','send_failed'\)/u,
  );
  assert.match(
    runbook,
    /action_approval_presentation_outbox outbox[\s\S]*JOIN action_approval_presentations presentation[\s\S]*presentation\.state IN \('pending_send','active','send_failed'\)/u,
  );
});

test("knowledge-conflict rollback rejects enabled groups, allowlists, and same-count transitions", () => {
  const validAttestation = {
    runtime: {
      globalEnabled: false,
      desiredGlobalEnabled: false,
      activationRequired: false,
      disabledGroupIds: ["group_a", "group_b"],
      capabilities: {
        readGroupDocuments: false,
        retrieveKnowledgeBase: false,
        proactiveSpeech: false,
        generateKnowledgeDrafts: false,
        writeKnowledgeBase: false,
      },
      persistence: { ok: true, storage: "postgres" },
    },
    status: {
      components: {
        knowledgeConflicts: { ok: true, enabled: false, running: false },
        actionApprovals: { ok: true, enabled: false, running: false },
      },
      knowledgeCards: {
        ok: true,
        enabled: false,
        running: false,
        enabledGroupCount: 0,
        queue: { pending: 0, processing: 0, delayed: 0, deadLetter: 0 },
        presentations: { pending_send: 0, active: 0, send_failed: 0, pendingSend: 0 },
        outbox: {
          pending: 0,
          processing: 0,
          external_attempting: 0,
          outcome_unknown: 0,
          terminalFailed: 0,
        },
      },
    },
    environment: {
      IRIS_KNOWLEDGE_CONFLICT_ENABLED: "false",
      IRIS_KNOWLEDGE_CONFLICT_GROUP_ALLOWLIST: "",
      IRIS_KNOWLEDGE_CARD_ENABLED: "false",
      IRIS_KNOWLEDGE_CARD_GROUP_IDS: "",
      IRIS_APPROVAL_ACTIONS_ENABLED: "false",
      IRIS_APPROVAL_ACTION_GROUP_IDS: "",
    },
    expectedGroupIds: ["group_a", "group_b"],
  };
  const attestationCommand = `Assert-RollbackRuntimeAttestation -Runtime $inputValue.runtime -Status $inputValue.status -Environment $inputValue.environment -ExpectedGroupIds @($inputValue.expectedGroupIds)`;
  assertPowerShellRunbookGate(attestationCommand, validAttestation, true);
  assertPowerShellRunbookGate(attestationCommand, {
    ...validAttestation,
    runtime: { ...validAttestation.runtime, disabledGroupIds: ["group_a"] },
  }, false);
  assertPowerShellRunbookGate(attestationCommand, {
    ...validAttestation,
    environment: {
      ...validAttestation.environment,
      IRIS_KNOWLEDGE_CONFLICT_GROUP_ALLOWLIST: "group_a",
    },
  }, false);
  const missingKnowledgeCards = {
    ...validAttestation,
    status: { components: validAttestation.status.components },
  };
  assertPowerShellRunbookGate(attestationCommand, missingKnowledgeCards, false);
  assertPowerShellRunbookGate(attestationCommand, {
    ...validAttestation,
    status: {
      ...validAttestation.status,
      knowledgeCards: {
        ...validAttestation.status.knowledgeCards,
        queue: { ...validAttestation.status.knowledgeCards.queue, pending: 1 },
      },
    },
  }, false);

  assertPowerShellRunbookGate(
    `Assert-FingerprintUnchanged -Before $inputValue.before -After $inputValue.after -Label 'quietness'`,
    {
      before: { scanInbox: { count: 1, stateHash: "aaa" } },
      after: { scanInbox: { count: 1, stateHash: "aaa" } },
    },
    true,
  );
  assertPowerShellRunbookGate(
    `Assert-FingerprintUnchanged -Before $inputValue.before -After $inputValue.after -Label 'quietness'`,
    {
      before: { scanInbox: { count: 1, stateHash: "aaa" } },
      after: { scanInbox: { count: 1, stateHash: "bbb" } },
    },
    false,
  );
});

test("knowledge-conflict disabled baseline attests every feature flag, allowlist, and runtime", () => {
  const valid = {
    runtime: {
      globalEnabled: false,
      desiredGlobalEnabled: false,
      activationRequired: false,
      disabledGroupIds: ["group_a", "group_b"],
      capabilities: {
        readGroupDocuments: false,
        retrieveKnowledgeBase: false,
        proactiveSpeech: false,
        generateKnowledgeDrafts: false,
        writeKnowledgeBase: false,
      },
      persistence: { ok: true, storage: "postgres" },
    },
    status: {
      components: {
        knowledgeConflicts: { ok: true, enabled: false, running: false },
        actionApprovals: { ok: true, enabled: false, running: false },
      },
      knowledgeCards: {
        ok: true,
        enabled: false,
        running: false,
        enabledGroupCount: 0,
        queue: { pending: 0, processing: 0, delayed: 0, deadLetter: 0 },
        presentations: { pending_send: 0, active: 0, send_failed: 0, pendingSend: 0 },
        outbox: {
          pending: 0,
          processing: 0,
          external_attempting: 0,
          outcome_unknown: 0,
          terminalFailed: 0,
        },
      },
    },
    environment: {
      IRIS_KNOWLEDGE_CONFLICT_ENABLED: "false",
      IRIS_KNOWLEDGE_CONFLICT_GROUP_ALLOWLIST: "",
      IRIS_KNOWLEDGE_CARD_ENABLED: "false",
      IRIS_KNOWLEDGE_CARD_GROUP_IDS: "",
      IRIS_APPROVAL_ACTIONS_ENABLED: "false",
      IRIS_APPROVAL_ACTION_GROUP_IDS: "",
    },
    expectedGroupIds: ["group_a", "group_b"],
  };
  const command = `Assert-DisabledBaselineAttestation -Runtime $inputValue.runtime -Status $inputValue.status -Environment $inputValue.environment -ExpectedGroupIds @($inputValue.expectedGroupIds)`;
  assertPowerShellRunbookGate(command, valid, true);
  assertPowerShellRunbookGate(command, {
    ...valid,
    environment: { ...valid.environment, IRIS_KNOWLEDGE_CARD_ENABLED: "true" },
  }, false);
  assertPowerShellRunbookGate(command, {
    ...valid,
    environment: { ...valid.environment, IRIS_KNOWLEDGE_CARD_GROUP_IDS: "group_a" },
  }, false);
  assertPowerShellRunbookGate(command, {
    ...valid,
    environment: { ...valid.environment, IRIS_APPROVAL_ACTIONS_ENABLED: "true" },
  }, false);
  assertPowerShellRunbookGate(command, {
    ...valid,
    environment: { ...valid.environment, IRIS_APPROVAL_ACTION_GROUP_IDS: "group_a" },
  }, false);
});

test("pilot shell scripts use LF endings for direct Linux execution", () => {
  for (const scriptPath of [
    backupPath,
    restorePath,
    semanticRecoveryProbePath,
    semanticOrderedReplayPath,
    semanticAcceptanceInspectPath,
    semanticSeedFromMessagesPath,
    semanticReseedFromMessagesPath,
    proactiveFeedbackAutoclosePath,
    postgresInitPath,
  ]) {
    const script = readFileSync(scriptPath, "utf8");
    assert.equal(script.includes("\r"), false, `${scriptPath} contains a CR byte`);
    assert.ok(script.startsWith("#!/usr/bin/env bash\n"), `${scriptPath} has an invalid shebang`);
  }
});

test("proactive feedback gray-window cleanup is bounded and proves fail-closed state", () => {
  assert.equal(existsSync(proactiveFeedbackAutoclosePath), true);
  const script = readFileSync(proactiveFeedbackAutoclosePath, "utf8");

  assert.match(script, /IRIS_PROACTIVE_FEEDBACK_AUTOCLOSE_CONFIRM/u);
  assert.match(script, /EUID/u);
  assert.match(script, /stop_caddy_bounded/u);
  assert.match(script, /\/internal\/runtime-control\/global/u);
  assert.match(script, /\/internal\/runtime-control\/groups\/\$\{encodeURIComponent\(groupId\)\}/u);
  assert.match(script, /proactiveSpeech: false/u);
  assert.match(script, /IRIS_KNOWLEDGE_CARD_ENABLED/u);
  assert.match(script, /IRIS_PROACTIVE_SIGNAL_PLANNER_ENABLED/u);
  assert.match(script, /IRIS_PROACTIVE_SIGNAL_DELIVERY_ENABLED/u);
  assert.match(script, /up --detach --wait --wait-timeout/u);
  assert.match(script, /globalEnabled !== false/u);
  assert.match(script, /desiredGlobalEnabled !== false/u);
  assert.match(script, /assertExactDisabledGroupSet/u);
  assert.match(script, /systemctl is-active --quiet caddy/u);
  assert.doesNotMatch(script, /\/scan|approve-delivery|feedback-summary/u);
});

test("Postgres initialization separates admin, migrator, and app roles", () => {
  const script = readFileSync(postgresInitPath, "utf8");
  assert.match(script, /IRIS_MIGRATOR_USER/u);
  assert.match(script, /IRIS_APP_USER/u);
  assert.match(script, /ALTER DEFAULT PRIVILEGES/u);
  assert.match(script, /CREATE EXTENSION IF NOT EXISTS vector/u);
});

test("backup is encrypted, atomic, and cannot mask pipeline failure", () => {
  const script = readFileSync(backupPath, "utf8");
  assert.match(script, /set -Eeuo pipefail/u);
  assert.match(script, /IRIS_BACKUP_RECIPIENT_FILE/u);
  assert.match(script, /flock -n/u);
  assert.match(script, /mktemp/u);
  assert.match(script, /pg_dump/u);
  assert.match(script, /stop_caddy_verified/u);
  assert.match(script, /stop core/u);
  assert.match(script, /redis-cli SAVE/u);
  assert.match(script, /redis\.rdb/u);
  assert.match(script, /tar --create/u);
  assert.match(script, /age --recipient/u);
  assert.match(script, /\.tmp/u);
  assert.match(script, /mv -- "\$temporary_file" "\$backup_file"/u);
});

test("planned backup restores runtime and ingress state only after publication", () => {
  const script = readFileSync(backupPath, "utf8");
  const captureRuntime = 'runtime_status="$(read_runtime_status)"';
  const disableRuntime = "set_runtime_enabled false";
  const stopCaddy = "stop_caddy_verified";
  const publishBackup = 'mv -- "$temporary_file" "$backup_file"';
  const restoreRuntime = "restore_runtime_state";
  const restoreCaddy = 'if [[ "$caddy_was_running" == true ]]';

  assert.match(script, /\/internal\/runtime-control\/status/u);
  assert.match(script, /\/internal\/runtime-control\/global/u);
  assert.match(script, /IRIS_INTERNAL_API_TOKEN/u);
  assert.match(script, /runtime_status="\$\(read_runtime_status\)"/u);
  assert.match(script, /runtime_revision/u);
  assert.match(script, /runtime_persistence_storage/u);
  assert.match(script, /runtime_persistence_ok/u);
  assert.match(script, /runtime_global_enabled=%s/u);
  assert.match(script, /runtime_revision=%s/u);
  assert.match(script, /caddy_was_running=false/u);
  assert.match(script, /start_core_disabled/u);
  assert.match(script, /expected runtime state/u);
  assert.match(script, /if \[\[ "\$runtime_was_enabled" == true \]\]/u);
  assert.match(script, /if \[\[ "\$caddy_was_running" == true \]\]/u);
  assert.match(script, /body\.durable !== true/u);

  const restoreStart = script.indexOf("restore_runtime_state() {");
  const restoreEnd = script.indexOf("cleanup() {", restoreStart);
  const restore = script.slice(restoreStart, restoreEnd);
  assert.doesNotMatch(restore, /desiredGlobalEnabled|runtime_desired/u);

  const captureRuntimeIndex = script.lastIndexOf(captureRuntime);
  const disableRuntimeIndex = script.lastIndexOf(`\n${disableRuntime}\n`);
  assert.ok(
    captureRuntimeIndex < disableRuntimeIndex,
    "runtime state must be captured before Core stops",
  );
  assert.ok(
    disableRuntimeIndex < script.indexOf(stopCaddy, disableRuntimeIndex),
    "live runtime must be disabled before Caddy stops",
  );
  assert.ok(
    script.indexOf(publishBackup) < script.lastIndexOf(restoreRuntime),
    "runtime state must be restored only after atomic backup publication",
  );
  assert.ok(
    script.indexOf(publishBackup) < script.lastIndexOf(restoreCaddy),
    "Caddy must be restored only after atomic backup publication",
  );
});

test("planned backup gates explicit restoration on durable status, healthy workers, and empty queues", () => {
  const script = readFileSync(backupPath, "utf8");
  assert.match(script, /persistence\?\.storage !== "postgres"/u);
  assert.match(script, /persistence\.ok !== true/u);
  assert.match(script, /pendingEventCount/u);
  assert.match(script, /deadLetterEventCount/u);
  assert.match(script, /pendingJobCount/u);
  assert.match(script, /deadLetterJobCount/u);

  const publishBackup = script.indexOf('mv -- "$temporary_file" "$backup_file"');
  const postRestartGate = script.indexOf("assert_runtime_activation_ready", publishBackup);
  const restoreRuntime = script.lastIndexOf("restore_runtime_state");
  assert.ok(postRestartGate > publishBackup, "post-restart gates must run after backup publication");
  assert.ok(postRestartGate < restoreRuntime, "post-restart gates must pass before restoration");
});

test("backup bounds every embedded HTTP request with a validated operator timeout", () => {
  const script = readFileSync(backupPath, "utf8");
  assert.match(script, /IRIS_BACKUP_HTTP_TIMEOUT_MS/u);
  assert.match(script, /10000/u);
  assert.match(script, /must be an integer between 100 and 60000/u);
  assert.equal(
    script.match(/AbortSignal\.timeout\(timeoutMs\)/gu)?.length,
    3,
    "status, mutation, and aggregate status fetches must all be bounded",
  );
});

test("backup validates decimal deadlines and bounds every Compose command", () => {
  const script = readFileSync(backupPath, "utf8");
  assert.match(script, /IRIS_BACKUP_COMMAND_TIMEOUT_SECONDS/u);
  assert.match(script, /normalize_decimal/u);
  assert.match(script, /IRIS_BACKUP_CLEANUP_RETRY_DELAY_SECONDS must be an integer between 0 and 10/u);
  assert.match(script, /cleanup_retry_count=3/u);
  assert.match(script, /timeout --kill-after=/u);
  assert.doesNotMatch(script, /timeout[^\n]*--foreground/u);
  assert.match(script, /docker compose .* timed out after/u);
  assert.doesNotMatch(script, /\$\(\(http_timeout_ms/u);
});

test("fail-closed cleanup requires durable disabled intent after restart", () => {
  const script = readFileSync(backupPath, "utf8");
  const recoveryStart = script.indexOf("recover_failed_maintenance() {");
  const recoveryEnd = script.indexOf("restore_runtime_state() {", recoveryStart);
  const recovery = script.slice(recoveryStart, recoveryEnd);
  assert.match(recovery, /set_runtime_enabled false/u);
  assert.doesNotMatch(recovery, /set_runtime_enabled false[^\n]*2>&1/u);
  assert.match(recovery, /assert_runtime_disabled_durable/u);
  assert.match(script, /"\$global_enabled" != false/u);
  assert.match(script, /"\$desired_global_enabled" != false/u);
  assert.match(script, /"\$activation_required" != false/u);
});

test("backup verifies explicit restoration before starting Caddy", () => {
  const script = readFileSync(backupPath, "utf8");
  const publishIndex = script.indexOf('mv -- "$temporary_file" "$backup_file"');
  const restorationIndex = script.lastIndexOf("restore_runtime_state");
  const caddyStartIndex = script.lastIndexOf("run_compose up --detach --wait --wait-timeout 120 caddy");
  assert.ok(publishIndex < restorationIndex, "restoration must follow publication");
  assert.ok(restorationIndex < caddyStartIndex, "Caddy must start after verified restoration");

  const restoreStart = script.indexOf("restore_runtime_state() {");
  const restoreEnd = script.indexOf("cleanup() {", restoreStart);
  const restore = script.slice(restoreStart, restoreEnd);
  assert.match(restore, /runtime_enable_attempted=true[\s\S]*set_runtime_enabled true/u);
  assert.match(restore, /set_runtime_enabled true[\s\S]*assert_runtime_state true/u);
});

test("backup failure cleanup keeps Iris disabled and Caddy stopped", () => {
  const script = readFileSync(backupPath, "utf8");
  const cleanupStart = script.indexOf("cleanup() {");
  const cleanupEnd = script.indexOf("trap cleanup EXIT");
  assert.ok(cleanupStart >= 0 && cleanupEnd > cleanupStart);

  const cleanup = script.slice(cleanupStart, cleanupEnd);
  assert.match(cleanup, /recover_failed_maintenance/u);
  assert.doesNotMatch(cleanup, /restore_runtime_state/u);
  assert.doesNotMatch(cleanup, /up .*caddy/u);
});

test("pilot runbook defines fail-closed restart, reactivation, and rollback ordering", () => {
  const readme = readFileSync(pilotReadmePath, "utf8");
  const orderedMarkers = [
    "POST global false",
    "Stop Caddy",
    "Verify workers, queues, and DLQs",
    "Create the paired Postgres backup",
    "Deploy migration and Core while Caddy remains stopped",
    "persistence.ok=true, globalEnabled=false",
    "Recheck that all workers are healthy and running and every queue and DLQ count is `0`",
    "Explicitly POST global true",
    "Start Caddy only after authenticated internal gates pass",
    "Run real Feishu acceptance",
  ];
  let previousIndex = -1;
  for (const marker of orderedMarkers) {
    const markerIndex = readme.indexOf(marker);
    assert.ok(markerIndex > previousIndex, `${marker} must appear in restart order`);
    previousIndex = markerIndex;
  }

  assert.match(readme, /durable=true/u);
  assert.match(readme, /desiredGlobalEnabled=true.*never.*auto-enable/isu);
  assert.match(
    readme,
    /restoring the Postgres snapshot\s+restores durable intent but never live activation/iu,
  );
  assert.match(readme, /backup, migration, or status.*Iris disabled and Caddy stopped/isu);
});

test("pilot runbook documents bounded backup cleanup controls", () => {
  const readme = readFileSync(pilotReadmePath, "utf8");
  assert.match(readme, /IRIS_BACKUP_COMMAND_TIMEOUT_SECONDS.*30.*1.*300/isu);
  assert.match(readme, /IRIS_BACKUP_CLEANUP_RETRY_DELAY_SECONDS.*2.*0.*10/isu);
  assert.match(readme, /exactly three Caddy stop attempts/iu);
});

test("semantic recovery probe checks fail-closed state and never replays DLQ entries", () => {
  const script = readFileSync(semanticRecoveryProbePath, "utf8");
  assert.match(script, /docker compose --env-file/u);
  assert.match(script, /exec -T\s+\\?\s+-e IRIS_SEMANTIC_RECOVERY_EXPECTED_DLQ_COUNT/u);
  assert.match(script, /core node --input-type=module/u);
  assert.match(script, /\/internal\/status/u);
  assert.match(script, /\/internal\/runtime-control\/status/u);
  assert.match(script, /\/internal\/memory-extraction\/status/u);
  assert.match(script, /\/internal\/memory-extraction\/dead-letters\?limit=20/u);
  assert.match(script, /IRIS_SEMANTIC_RECOVERY_EXPECTED_DLQ_COUNT/u);
  assert.match(script, /expectedDlqCount/u);
  assert.match(script, /zeroIfMissing/u);
  assert.match(script, /\/v1\/memory\/extract/u);
  assert.match(script, /schema_version: 2/u);
  assert.match(script, /globalEnabled !== false/u);
  assert.match(script, /desiredGlobalEnabled !== false/u);
  assert.match(script, /proactiveSpeech !== false/u);
  assert.match(script, /dlq\.deadLetters\.length !== expectedDlqCount/u);
  assert.match(script, /Expected semantic DLQ count/u);
  assert.match(script, /classifyProbeFailure/u);
  assert.doesNotMatch(script, /\/replay/u);
  assert.doesNotMatch(script, /console\.log\(.*internalToken/u);
  assert.doesNotMatch(script, /console\.log\(.*aiWorkerToken/u);
});

test("semantic ordered replay helper gates execution and replays one DLQ at a time", () => {
  const script = readFileSync(semanticOrderedReplayPath, "utf8");
  assert.match(script, /IRIS_SEMANTIC_REPLAY_CONFIRM/u);
  assert.match(script, /semantic-recovery-probe\.sh/u);
  assert.match(script, /\/internal\/runtime-control\/global/u);
  assert.match(script, /\/internal\/runtime-control\/groups\/\$\{groupId\}/u);
  assert.match(script, /\/internal\/memory-extraction\/dead-letters\?limit=20/u);
  assert.match(script, /sort\(\(a, b\) => String\(a\.enqueuedAt/u);
  assert.match(script, /\/internal\/memory-extraction\/dead-letters\/\$\{encodeURIComponent\(deadLetter\.id\)\}\/replay/u);
  assert.match(script, /await waitForMemoryDrain/u);
  assert.match(script, /for \(const deadLetter of orderedDeadLetters\)/u);
  assert.match(script, /remainingAllowedIds\.delete\(deadLetter\.id\)/u);
  assert.match(script, /assertOnlyRemainingOriginalDlq\(remainingAllowedIds\)/u);
  assert.match(script, /unexpectedIds\.length > 0/u);
  assert.match(script, /finally \{/u);
  assert.match(script, /globalEnabled !== false/u);
  assert.match(script, /desiredGlobalEnabled !== false/u);
  assert.match(script, /proactiveSpeech/u);
  assert.match(script, /stop caddy/u);
  assert.doesNotMatch(script, /dead-letters\/replay/u);
  assert.doesNotMatch(script, /\/v1\/memory\/extract/u);
});

test("semantic seed helper backfills real pilot messages without opening public ingress", () => {
  const script = readFileSync(semanticSeedFromMessagesPath, "utf8");
  assert.match(script, /IRIS_SEMANTIC_SEED_CONFIRM/u);
  assert.match(script, /SEED_SEMANTIC_MESSAGES/u);
  assert.match(script, /IRIS_SEMANTIC_SEED_PILOT_GROUP_ID/u);
  assert.match(script, /IRIS_SEMANTIC_SEED_MARKER/u);
  assert.match(script, /IRIS_SEMANTIC_SEED_LIMIT/u);
  assert.equal(script.includes('marker" == *"_"*'), false);
  assert.match(script, /escapeSqlLikePattern/u);
  assert.match(script, /LIKE '%' \|\| \$2 \|\| '%' ESCAPE '\\\\'/u);
  assert.match(script, /exec -T\s+\\?\s+-e IRIS_SEMANTIC_SEED_PILOT_GROUP_ID/u);
  assert.match(script, /-e IRIS_SEMANTIC_SEED_MARKER/u);
  assert.match(script, /-e IRIS_SEMANTIC_SEED_LIMIT/u);
  assert.match(script, /FROM conversation_messages/u);
  assert.match(script, /SELECT id, provider_message_id, chat_id, text/u);
  assert.match(script, /ORDER BY sent_at ASC, created_at ASC, id ASC/u);
  assert.match(script, /semantic-evidence-integrity\.js/u);
  assert.match(
    script,
    /for \(const row of messages\.rows\) \{\s+assertSemanticEvidenceIntegrity\(\{\s+text: row\.text,\s+marker,\s+messageId: row\.id,\s+\}\);\s+\}\s+let createdCount/u,
  );
  assert.ok(
    script.indexOf("text: row.text") <
      script.indexOf("repository.registerRequest"),
  );
  assert.match(script, /createPostgresMemoryExtractionRepository/u);
  assert.match(script, /createRedisMemoryExtractionQueue/u);
  assert.match(script, /registerRequest/u);
  assert.match(script, /createMemoryExtractionJob/u);
  assert.match(script, /queue\.enqueue/u);
  assert.match(script, /createdCount/u);
  assert.match(script, /enqueuedCount/u);
  assert.doesNotMatch(script, /runtime-control\/global/u);
  assert.doesNotMatch(script, /up .*caddy/u);
  assert.doesNotMatch(script, /stop caddy/u);
});

test("semantic reseed helper resets approved marker messages one at a time", () => {
  const script = readFileSync(semanticReseedFromMessagesPath, "utf8");
  assert.match(script, /IRIS_SEMANTIC_RESEED_CONFIRM/u);
  assert.match(script, /RESET_SEMANTIC_MESSAGES_ONE_BY_ONE/u);
  assert.match(script, /IRIS_SEMANTIC_RESEED_PILOT_GROUP_ID/u);
  assert.match(script, /IRIS_SEMANTIC_RESEED_MARKER/u);
  assert.match(script, /LIKE '%' \|\| \$2 \|\| '%' ESCAPE '\\\\'/u);
  assert.match(script, /cm\.text AS message_text/u);
  assert.match(script, /ORDER BY cm\.sent_at ASC, cm\.created_at ASC, cm\.id ASC/u);
  assert.match(script, /semantic-evidence-integrity\.js/u);
  assert.match(
    script,
    /assertSemanticEvidenceIntegrity\(\{\s+text: row\.message_text,\s+marker,\s+messageId: row\.message_id,\s+\}\)/u,
  );
  assert.ok(
    script.indexOf("text: row.message_text") <
      script.indexOf("UPDATE group_memory_extraction_requests"),
  );
  assert.match(script, /FOR UPDATE/u);
  assert.match(script, /DELETE FROM group_memory_extraction_conflict_evidence/u);
  assert.match(script, /DELETE FROM group_memory_extraction_conflict_candidates/u);
  assert.match(script, /DELETE FROM group_memory_extraction_run_evidence/u);
  assert.match(script, /DELETE FROM group_memory_extraction_run_context/u);
  assert.match(script, /DELETE FROM group_memory_extraction_run_memories/u);
  assert.match(script, /DELETE FROM group_memory_extraction_run_threads/u);
  assert.match(script, /DELETE FROM group_memory_extraction_run_actions/u);
  assert.match(script, /UPDATE group_memory_extraction_requests/u);
  assert.match(script, /status = 'pending'/u);
  assert.match(script, /createMemoryExtractionJob/u);
  assert.match(script, /queue\.enqueue/u);
  assert.match(script, /await waitForMemoryDrain/u);
  assert.match(script, /await markRequestSkipped/u);
  assert.match(script, /replay_drain_timeout/u);
  assert.match(script, /for \(const row of messages\)/u);
  assert.match(script, /\/internal\/runtime-control\/global/u);
  assert.match(script, /\/internal\/runtime-control\/groups\/\$\{groupId\}/u);
  assert.match(script, /finally \{/u);
  assert.match(script, /globalEnabled !== false/u);
  assert.match(script, /desiredGlobalEnabled !== false/u);
  assert.match(script, /proactiveSpeech/u);
  assert.match(script, /stop caddy/u);
  assert.match(script, /resetCount/u);
  assert.match(script, /enqueuedCount/u);
  assert.doesNotMatch(script, /up .*caddy/u);
});

test("fresh semantic acceptance waits through bounded model retries without deleting history", () => {
  const script = readFileSync(semanticFreshAcceptancePath, "utf8");
  const actionCommitmentStep = sliceBetween(
    script,
    'stepName: "action_commitment"',
    'stepName: "mention_question"',
  );
  const mentionQuestionStep = sliceBetween(
    script,
    'stepName: "mention_question"',
    'stepName: "completion_and_resolution"',
  );
  const completionAndResolutionStep = sliceBetween(
    script,
    'stepName: "completion_and_resolution"',
    'stepName: "thread_reopening"',
  );
  const threadReopeningStep = sliceBetween(
    script,
    'stepName: "thread_reopening"',
    "  const expected = expectedByStep[step - 1];",
  );
  assert.match(script, /IRIS_SEMANTIC_FRESH_ACCEPTANCE_CONFIRM/u);
  assert.match(script, /RUN_FRESH_SEMANTIC_ACCEPTANCE_ONE_BY_ONE/u);
  assert.match(script, /IRIS_SEMANTIC_FRESH_ACCEPTANCE_GROUP_ID/u);
  assert.match(script, /IRIS_SEMANTIC_FRESH_ACCEPTANCE_MARKER/u);
  assert.match(script, /IRIS_SEMANTIC_FRESH_ACCEPTANCE_KNOWN_GROUP_IDS/u);
  assert.match(script, /expected_count != 6/u);
  assert.match(script, /IRIS_SEMANTIC_FRESH_ACCEPTANCE_COMMAND_TIMEOUT_SECONDS/u);
  assert.match(script, /IRIS_SEMANTIC_FRESH_ACCEPTANCE_REQUEST_TIMEOUT_MS/u);
  assert.match(script, /cleanup_timeout_seconds/u);
  assert.match(script, /known_group_count/u);
  assert.match(script, /semantic-evidence-integrity\.js/u);
  assert.match(script, /assertSemanticEvidenceIntegrity/u);
  assert.match(script, /ORDER BY sent_at ASC, created_at ASC, id ASC/u);
  assert.match(script, /registerRequest/u);
  assert.match(script, /result\.created !== true/u);
  assert.match(script, /for \(const row of messages\)/u);
  assert.match(script, /await waitForRequestTerminal\(result\.request\.id\)/u);
  assert.match(script, /request\.status === "completed"/u);
  assert.match(script, /request\.status === "completed" && queueDrained/u);
  assert.match(script, /run\.enabled_operation_families/u);
  assert.match(script, /assertEnabledOperationFamilies/u);
  assert.match(script, /await assertSemanticLifecycleAfterStep\(results\.length/u);
  assert.match(script, /Expected exactly one semantic acceptance thread/u);
  assert.match(script, /Expected exactly one action bound to the semantic acceptance thread/u);
  assert.match(script, /stepName: "mention_question"/u);
  assert.match(script, /stepName: "completion_and_resolution"/u);
  assertStepLifecycle(actionCommitmentStep, {
    threadVersion: 3,
    threadEvents: [
      ["created", 1, 0],
      ["promoted", 2, 1],
      ["evidence_attached", 3, 2],
    ],
    actionStatus: "open",
    actionVersion: 1,
    actionEvents: [["created", 1, 2]],
  });
  assertStepLifecycle(mentionQuestionStep, {
    threadVersion: 3,
    threadEvents: [
      ["created", 1, 0],
      ["promoted", 2, 1],
      ["evidence_attached", 3, 2],
    ],
    actionStatus: "open",
    actionVersion: 1,
    actionEvents: [["created", 1, 2]],
  });
  assertStepLifecycle(completionAndResolutionStep, {
    threadVersion: 4,
    threadEvents: [
      ["created", 1, 0],
      ["promoted", 2, 1],
      ["evidence_attached", 3, 2],
      ["resolved", 4, 4],
    ],
    actionStatus: "completed",
    actionVersion: 2,
    actionEvents: [
      ["created", 1, 2],
      ["completed", 2, 4],
    ],
  });
  assertStepLifecycle(threadReopeningStep, {
    threadVersion: 5,
    threadEvents: [
      ["created", 1, 0],
      ["promoted", 2, 1],
      ["evidence_attached", 3, 2],
      ["resolved", 4, 4],
      ["reopened", 5, 5],
    ],
    actionStatus: "completed",
    actionVersion: 2,
    actionEvents: [
      ["created", 1, 2],
      ["completed", 2, 4],
    ],
  });
  assert.match(script, /commitmentOwnerOpenId/u);
  assert.match(script, /action\.owner_ref !== commitmentOwnerOpenId/u);
  assert.match(script, /completionOwnerOpenId !== commitmentOwnerOpenId/u);
  assert.match(script, /request\.status === "skipped"/u);
  assert.match(script, /invalid_model_response_retry/u);
  assert.match(script, /delayedJobCount/u);
  assert.match(script, /requireQueueCount/u);
  assert.match(script, /requireDeadLetters/u);
  assert.doesNotMatch(script, /deadLetters\.deadLetters \?\? \[\]/u);
  assert.doesNotMatch(script, /(?:pending|processing|delayed)JobCount \?\? 0/u);
  assert.match(script, /\/internal\/memory-extraction\/dead-letters\?limit=20/u);
  assert.match(script, /\/internal\/runtime-control\/global/u);
  assert.match(
    script,
    /\/internal\/runtime-control\/groups\/\$\{encodeURIComponent\(groupId\)\}/u,
  );
  assert.match(script, /globalEnabled !== false/u);
  assert.match(script, /desiredGlobalEnabled !== false/u);
  assert.match(script, /proactiveSpeech !== false/u);
  assert.match(script, /assertExactDisabledGroupSet/u);
  assert.match(script, /assertKnownGroupInventory/u);
  assert.match(script, /finally \{/u);
  assert.doesNotMatch(script, /if \(privateWindowOpened\)/u);
  assert.match(script, /await safeMutation\(\(\) => setGlobal\(false\)\)/u);
  assert.match(script, /await disableKnownGroups/u);
  assert.doesNotMatch(script, /safeMutation\(\(\) => assertFinalFailClosed/u);
  assert.match(script, /AbortSignal\.timeout/u);
  assert.match(script, /timeout --kill-after=/u);
  assert.match(script, /core sh -c/u);
  assert.match(script, /exec timeout --signal=TERM --kill-after=15s/u);
  assert.match(script, /IRIS_SEMANTIC_FRESH_ACCEPTANCE_RUN_TOKEN/u);
  assert.match(script, /IRIS_SEMANTIC_FRESH_ACCEPTANCE_PID_FILE/u);
  assert.match(script, /terminate_acceptance_process/u);
  assert.match(script, /readdir\("\/proc"/u);
  assert.match(script, /\/proc\/\$\{pid\}\/environ/u);
  assert.match(script, /waitForMatchingProcesses/u);
  assert.match(script, /waitForStableAbsence/u);
  assert.match(script, /process\.kill\(pid, "SIGTERM"\)/u);
  assert.match(script, /process\.kill\(pid, "SIGKILL"\)/u);
  assert.match(script, /trap .*EXIT/u);
  assert.match(script, /force_fail_closed/u);
  assert.match(script, /parsed\.durable !== true/u);
  assert.match(script, /stop_caddy_bounded/u);
  assert.doesNotMatch(script, /^\s*"\$\{compose\[@\]\}" stop caddy/gmu);
  assert.match(script, /connectionTimeoutMillis: requestTimeoutMs/u);
  assert.match(script, /queryTimeoutMillis: requestTimeoutMs/u);
  assert.match(script, /statementTimeoutMillis: requestTimeoutMs/u);
  assert.match(script, /lockTimeoutMillis: requestTimeoutMs/u);
  assert.match(script, /enqueueWithRedisDeadline/u);
  assert.match(script, /redisTimedOut = true/u);
  assert.match(script, /redis\.destroy\(\)/u);
  assert.doesNotMatch(script, /redis\.withAbortSignal/u);
  assert.match(script, /cleanupFailures/u);
  assert.match(script, /assertExactDisabledGroupSet\(status\.disabledGroupIds, knownGroupIds\)/u);
  assert.match(script, /for \(const knownGroupId of knownGroupIds\)/u);
  assert.doesNotMatch(script, /Promise\.allSettled\(\s*knownGroupIds\.map/u);
  assert.doesNotMatch(script, /DELETE FROM/u);
  assert.doesNotMatch(script, /UPDATE group_memory_extraction_requests/u);
  assert.doesNotMatch(script, /up .*caddy/u);
  const cleanupBody = script.slice(
    script.indexOf("force_fail_closed() {"),
    script.indexOf("trap force_fail_closed EXIT"),
  );
  assert.ok(
    cleanupBody.indexOf("terminate_acceptance_process") <
      cleanupBody.indexOf("stop_caddy_bounded"),
    "cleanup must terminate the container-side acceptance process before proving fail-closed",
  );
  assert.ok(
    script.indexOf("await assertSemanticLifecycleAfterStep(results.length") <
      script.indexOf("console.log(JSON.stringify(acceptanceSummary))"),
    "the full semantic lifecycle must be proven before reporting success",
  );
  assert.ok(
    script.indexOf("await assertFinalFailClosed()") <
      script.indexOf("console.log(JSON.stringify(acceptanceSummary))"),
    "the final fail-closed state must be proven before reporting success",
  );
});

test("semantic acceptance inspector validates lifecycle without mutating runtime or public ingress", () => {
  const script = readFileSync(semanticAcceptanceInspectPath, "utf8");
  const threadLifecycle = sliceBetween(
    script,
    "const expectedThreadLifecycle = [",
    "const expectedActionLifecycle = [",
  );
  const actionLifecycle = sliceBetween(
    script,
    "const expectedActionLifecycle = [",
    "await assertFailClosedRuntime();",
  );
  assert.deepEqual(readInspectorLifecycle(threadLifecycle), [
    ["created", 1],
    ["promoted", 2],
    ["evidence_attached", 3],
    ["resolved", 4],
    ["reopened", 5],
  ]);
  assert.deepEqual(readInspectorLifecycle(actionLifecycle), [
    ["created", 1],
    ["completed", 2],
  ]);
  assert.match(script, /IRIS_SEMANTIC_ACCEPTANCE_PILOT_GROUP_ID/u);
  assert.match(script, /IRIS_SEMANTIC_ACCEPTANCE_CONTROL_GROUP_ID/u);
  assert.match(script, /exec -T\s+\\?\s+-e PILOT_GROUP_ID/u);
  assert.match(script, /-e CONTROL_GROUP_ID/u);
  assert.match(script, /\/internal\/runtime-control\/status/u);
  assert.match(script, /\/internal\/status/u);
  assert.match(script, /\/internal\/memory-extraction\/status/u);
  assert.match(script, /\/internal\/memory-extraction\/dead-letters\?limit=20/u);
  assert.match(script, /status\.components\?\.eventWorker/u);
  assert.match(script, /zeroIfMissing/u);
  assert.match(script, /\/internal\/conversation-state\/groups\/\$\{encodeURIComponent\(pilotGroupId\)\}\/threads/u);
  assert.match(script, /\/internal\/conversation-state\/groups\/\$\{encodeURIComponent\(pilotGroupId\)\}\/actions/u);
  assert.match(script, /\/internal\/conversation-state\/threads\/\$\{encodeURIComponent\(thread\.id\)\}\/events/u);
  assert.match(script, /\/internal\/conversation-state\/actions\/\$\{encodeURIComponent\(action\.id\)\}\/events/u);
  assert.match(script, /created/u);
  assert.match(script, /promoted/u);
  assert.match(script, /evidence_attached/u);
  assert.match(script, /resolved/u);
  assert.match(script, /reopened/u);
  assert.match(script, /completed/u);
  assert.match(script, /hasExactEventLifecycle/u);
  assert.match(script, /events\.length !== expectedLifecycle\.length/u);
  assert.match(script, /thread\.version !== 5/u);
  assert.match(script, /action\.version !== 2/u);
  assert.doesNotMatch(script, /hasDuplicateLifecycleVersions/u);
  assert.match(script, /projectionRepairs/u);
  assert.match(script, /assertNoOutstandingProjectionRepairs/u);
  assert.match(script, /expectedStatuses = \["pending", "processing", "completed", "failed"\]/u);
  assert.match(script, /Object\.hasOwn\(counts, status\)/u);
  assert.doesNotMatch(
    script,
    /assertZeroCounts\(stateStatus\.projectionRepairs/u,
  );
  assert.match(script, /controlGroupId/u);
  assert.doesNotMatch(script, /\/internal\/runtime-control\/global/u);
  assert.doesNotMatch(script, /\/internal\/memory-extraction\/dead-letters\/.*\/replay/u);
  assert.doesNotMatch(script, /stop caddy/u);
  assert.doesNotMatch(script, /\/v1\/memory\/extract/u);
});

test("semantic inspector repair gate allows only valid completed history", () => {
  const script = readFileSync(semanticAcceptanceInspectPath, "utf8");
  assert.doesNotThrow(() => runProjectionRepairGate(script, {
    pending: 0,
    processing: 0,
    completed: 22,
    failed: 0,
  }));
  for (const status of ["pending", "processing", "failed"]) {
    assert.throws(
      () => runProjectionRepairGate(script, {
        pending: 0,
        processing: 0,
        completed: 22,
        failed: 0,
        [status]: 1,
      }),
      new RegExp(`projectionRepairs\\.${status}`, "u"),
    );
  }
  for (const invalidCounts of [
    undefined,
    {},
    { pending: 0, processing: 0, completed: 22 },
    { pending: null, processing: 0, completed: 22, failed: 0 },
    { pending: 0, processing: 0, completed: -1, failed: 0 },
    { pending: 0, processing: 0, completed: 22.5, failed: 0 },
    { pending: 0, processing: 0, completed: 22, failed: 0, cancelled: 1 },
  ]) {
    assert.throws(
      () => runProjectionRepairGate(script, invalidCounts),
      /projection repairs status counts/u,
    );
  }
});

test("semantic lifecycle source parsing includes multiline and extended events", () => {
  assert.deepEqual(readStepEvents(`
    events: [
      { type: "created", version: 1, triggerIndex: 0 },
      {
        type: "promoted",
        version: 2,
        triggerIndex: 1,
        note: "must not be ignored",
      },
    ],
  `), [
    ["created", 1, 0],
    ["promoted", 2, 1],
  ]);
  assert.deepEqual(readInspectorLifecycle(`
    const expectedLifecycle = [
      { eventType: "created", toVersion: 1 },
      {
        eventType: "promoted",
        toVersion: 2,
        note: "must not be ignored",
      },
    ];
  `), [
    ["created", 1],
    ["promoted", 2],
  ]);
});

test("semantic lifecycle source parsing pins the top-level action version", () => {
  assert.throws(
    () => assertStepLifecycle(`
      threadVersion: 3,
      threadEvents: [
        { type: "created", version: 1, triggerIndex: 0 },
      ],
      action: {
        status: "completed",
        version: 99,
        events: [
          { type: "created", version: 1, triggerIndex: 0 },
          { type: "completed", version: 2, triggerIndex: 1 },
        ],
      },
    `, {
      threadVersion: 3,
      threadEvents: [["created", 1, 0]],
      actionStatus: "completed",
      actionVersion: 2,
      actionEvents: [
        ["created", 1, 0],
        ["completed", 2, 1],
      ],
    }),
    /version: 2/u,
  );
});

function sliceBetween(value, startToken, endToken) {
  const start = value.indexOf(startToken);
  assert.notEqual(start, -1, `missing start token: ${startToken}`);
  const end = value.indexOf(endToken, start + startToken.length);
  assert.notEqual(end, -1, `missing end token: ${endToken}`);
  return value.slice(start, end);
}

function assertStepLifecycle(
  stepBlock,
  {
    threadVersion,
    threadEvents,
    actionStatus,
    actionVersion,
    actionEvents,
  },
) {
  const actionIndex = stepBlock.indexOf("action:");
  assert.notEqual(actionIndex, -1, "step block is missing an action contract");
  const threadBlock = stepBlock.slice(0, actionIndex);
  const actionBlock = stepBlock.slice(actionIndex);
  const actionEventsIndex = actionBlock.indexOf("events:");
  assert.notEqual(actionEventsIndex, -1, "action contract is missing events");
  const actionHeader = actionBlock.slice(0, actionEventsIndex);
  assert.match(threadBlock, new RegExp(`threadVersion: ${threadVersion},`, "u"));
  assert.deepEqual(readStepEvents(threadBlock, "threadEvents:"), threadEvents);
  assert.match(actionHeader, new RegExp(`status: "${actionStatus}",`, "u"));
  assert.match(actionHeader, new RegExp(`version: ${actionVersion},`, "u"));
  assert.deepEqual(readStepEvents(actionBlock), actionEvents);
}

function readStepEvents(value, startToken = "events:") {
  return Array.from(readSourceArray(value, startToken), (event) => {
    assert.equal(typeof event?.type, "string");
    assert.equal(Number.isSafeInteger(event?.version), true);
    assert.equal(Number.isSafeInteger(event?.triggerIndex), true);
    return [event.type, event.version, event.triggerIndex];
  });
}

function readInspectorLifecycle(value) {
  return Array.from(readSourceArray(value), (event) => {
    assert.equal(typeof event?.eventType, "string");
    assert.equal(Number.isSafeInteger(event?.toVersion), true);
    return [event.eventType, event.toVersion];
  });
}

function runProjectionRepairGate(script, input) {
  const repairGate = sliceBetween(
    script,
    "function assertNoOutstandingProjectionRepairs",
    "\n\nfunction zeroIfMissing",
  );
  const zeroIfMissing = sliceBetween(
    script,
    "function zeroIfMissing",
    "\n\nasync function getJson",
  );
  runInNewContext(
    `${repairGate}\n${zeroIfMissing}\nassertNoOutstandingProjectionRepairs(input);`,
    { input },
    { timeout: 100 },
  );
}

function readSourceArray(value, startToken) {
  const searchStart = startToken === undefined ? 0 : value.indexOf(startToken);
  assert.notEqual(searchStart, -1, `missing array token: ${startToken}`);
  const arrayStart = value.indexOf("[", searchStart);
  assert.notEqual(arrayStart, -1, "missing source array");
  let depth = 0;
  let quote;
  let escaped = false;
  for (let index = arrayStart; index < value.length; index += 1) {
    const character = value[index];
    if (quote !== undefined) {
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === quote) {
        quote = undefined;
      }
      continue;
    }
    if (character === '"' || character === "'" || character === "`") {
      quote = character;
      continue;
    }
    if (character === "[") {
      depth += 1;
      continue;
    }
    if (character !== "]") continue;
    depth -= 1;
    if (depth !== 0) continue;
    const parsed = runInNewContext(
      `(${value.slice(arrayStart, index + 1)})`,
      Object.create(null),
      { timeout: 100 },
    );
    assert.equal(Array.isArray(parsed), true);
    return parsed;
  }
  assert.fail("unterminated source array");
}

test("pilot rollback documents decrypted stdin restore and Caddy-last reactivation", () => {
  const readme = readFileSync(pilotReadmePath, "utf8");
  const rollback = readme.slice(readme.indexOf("## Rollback"));
  assert.match(rollback, /IRIS_BACKUP_IDENTITY_FILE/u);
  assert.match(
    rollback,
    /age --decrypt --identity "\$IRIS_BACKUP_IDENTITY_FILE" "\$backup_file"\s*\\\s*\| \.\/deploy\/pilot\/restore-from-stdin\.sh --confirm-replace-database/u,
  );
  const pipelineIndex = rollback.indexOf("age --decrypt");
  const localhostGateIndex = rollback.indexOf("authenticated localhost gates");
  const enableIndex = rollback.indexOf("Explicitly POST global true");
  const caddyIndex = rollback.indexOf("Start Caddy last");
  assert.ok(pipelineIndex < localhostGateIndex);
  assert.ok(localhostGateIndex < enableIndex);
  assert.ok(enableIndex < caddyIndex);
});

test("CI runs the private-first post-restore smoke mode after restore", () => {
  const workflow = readFileSync(ciWorkflowPath, "utf8");
  const restore = workflow.indexOf("restore-from-stdin.sh --confirm-replace-database");
  const postRestoreSmoke = workflow.indexOf(
    "npm run pilot:smoke -- --post-restore",
    restore,
  );
  assert.ok(restore >= 0);
  assert.ok(postRestoreSmoke > restore);
});

test("CI runs the proactive pre-send suppression race against real Postgres", () => {
  const workflow = readFileSync(ciWorkflowPath, "utf8");
  const postgresIntegrations = workflow.slice(
    workflow.indexOf("- name: Test Postgres integrations"),
    workflow.indexOf("- name: Validate Docker Compose"),
  );

  assert.match(
    postgresIntegrations,
    /IRIS_TEST_DATABASE_URL: postgres:\/\/iris:iris@localhost:5432\/iris/u,
  );
  assert.match(
    postgresIntegrations,
    /npm --workspace apps\/core test -- agent-execution-ledger\.test\.ts/u,
  );
});

test("CI keeps the pilot queues empty before the backup drill", () => {
  const workflow = readFileSync(ciWorkflowPath, "utf8");
  const startStack = workflow.indexOf("- name: Start pilot stack");
  const backupDrill = workflow.indexOf(
    "- name: Drill paired pilot backup and restore",
    startStack,
  );

  assert.ok(startStack >= 0);
  assert.ok(backupDrill > startStack);
  assert.doesNotMatch(
    workflow.slice(startStack, backupDrill),
    /npm run pilot:smoke(?:\s|$)/u,
  );
});

test("CI waits for queue drain after Redis recovery before ordinary smoke", () => {
  const workflow = readFileSync(ciWorkflowPath, "utf8");
  const redisRecovery = workflow.indexOf(
    "- name: Reject callbacks while Redis ingress is unavailable",
  );
  const ordinarySmoke = workflow.indexOf("npm run pilot:smoke", redisRecovery);
  const recoveryGate = workflow.slice(redisRecovery, ordinarySmoke);

  assert.ok(redisRecovery >= 0);
  assert.ok(ordinarySmoke > redisRecovery);
  assert.match(recoveryGate, /pendingEventCount/u);
  assert.match(recoveryGate, /pendingJobCount/u);
  assert.match(recoveryGate, /deadLetterEventCount/u);
  assert.match(recoveryGate, /deadLetterJobCount/u);
  assert.match(recoveryGate, /test "\$queues_drained" = true/u);
});

test("restore requires confirmation and fails closed through transactional restore", () => {
  const script = readFileSync(restorePath, "utf8");
  assert.match(script, /--confirm-replace-database/u);
  assert.match(script, /mktemp/u);
  assert.match(script, /pg_restore --list/u);
  assert.match(script, /staging_database/u);
  assert.match(script, /previous_database/u);
  assert.match(script, /redis_previous/u);
  assert.match(script, /grant-app-access\.sql/u);
  assert.match(script, /iris_restore_permission_probe/u);
  assert.match(script, /iris_forbidden_app_ddl/u);
  assert.match(script, /stop_caddy_verified/u);
  assert.match(script, /run_compose stop core/u);
  assert.match(script, /createdb/u);
  assert.match(script, /--exit-on-error/u);
  assert.match(script, /--single-transaction/u);
  assert.match(script, /--no-comments/u);
  assert.match(script, /stop redis/u);
  assert.match(script, /appendonlydir/u);
  assert.match(script, /run --rm .* migrate/u);
  assert.match(script, /up --detach --wait/u);
  const postSwap = script.slice(script.indexOf("stop_caddy_verified"));
  assert.match(postSwap, /run_compose up --detach --wait --wait-timeout 120 core/u);
  assert.doesNotMatch(postSwap, /up --detach[^\n]*caddy/u);
  const swapSql = readFileSync("deploy/pilot/swap-databases.sql", "utf8");
  assert.match(swapSql, /ALTER DATABASE %I RENAME TO %I/u);
  const grantSql = readFileSync("deploy/pilot/grant-app-access.sql", "utf8");
  assert.match(grantSql, /ALTER DEFAULT PRIVILEGES/u);
  const destructiveStop = script.lastIndexOf("\nstop_caddy_verified\n");
  assert.ok(
    script.indexOf("--dbname \"$IRIS_RESTORE_DATABASE\"") <
      destructiveStop,
    "the staging database must be fully restored before traffic stops",
  );
  assert.ok(
    script.indexOf("exec node apps/core/dist/database/migrate.js") <
      destructiveStop,
    "the staging database must be migrated before traffic stops",
  );
});

test("restore validates decimal deadlines and bounds every Compose operation", () => {
  const script = readFileSync(restorePath, "utf8");
  assert.match(script, /IRIS_RESTORE_COMMAND_TIMEOUT_SECONDS/u);
  assert.match(script, /IRIS_RESTORE_CLEANUP_RETRY_DELAY_SECONDS/u);
  assert.match(script, /normalize_decimal/u);
  assert.match(script, /cleanup_retry_count=3/u);
  assert.match(script, /timeout --kill-after=/u);
  assert.doesNotMatch(script, /timeout[^\n]*--foreground/u);
  assert.equal(
    script.match(/"\$\{compose\[@\]\}"/gu)?.length,
    1,
    "only run_compose may invoke the Compose array",
  );
});

test("restore proves Caddy stopped before stopping Core or swapping databases", () => {
  const script = readFileSync(restorePath, "utf8");
  const stopCaddy = script.lastIndexOf("\nstop_caddy_verified\n");
  const stopCore = script.indexOf("run_compose stop core", stopCaddy);
  const swapDatabase = script.indexOf("swap-databases.sql", stopCore);
  assert.ok(stopCaddy >= 0);
  assert.ok(stopCaddy < stopCore);
  assert.ok(stopCore < swapDatabase);
});

function assertPowerShellRunbookGate(
  command,
  input,
  expectedSuccess,
  runbookPath = knowledgeConflictAcceptancePath,
) {
  const runbook = readFileSync(runbookPath, "utf8");
  const controllerStart = runbook.indexOf('$ErrorActionPreference = "Stop"');
  const controllerEnd = runbook.indexOf("$acceptanceResult = $null", controllerStart);
  assert.ok(controllerStart >= 0 && controllerEnd > controllerStart, "missing controller source");
  const inputJson = JSON.stringify(input).replaceAll("'", "''");
  const script = [
    runbook.slice(controllerStart, controllerEnd),
    `$inputValue = '${inputJson}' | ConvertFrom-Json`,
    command,
  ].join("\n");
  const result = spawnSync("pwsh", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "-"], {
    encoding: "utf8",
    input: script,
    timeout: 10_000,
  });
  assert.equal(
    result.status === 0,
    expectedSuccess,
    result.stderr || result.stdout || `PowerShell exited ${result.status}`,
  );
}

function bashPath() {
  if (process.platform !== "win32") {
    return "bash";
  }

  const gitBash = "C:\\Program Files\\Git\\bin\\bash.exe";
  return existsSync(gitBash) ? gitBash : undefined;
}

function assertMarkersInOrder(value, markers) {
  let previousIndex = -1;
  for (const marker of markers) {
    const markerIndex = value.indexOf(marker, previousIndex + 1);
    assert.ok(markerIndex > previousIndex, `${marker} must appear in order`);
    previousIndex = markerIndex;
  }
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
