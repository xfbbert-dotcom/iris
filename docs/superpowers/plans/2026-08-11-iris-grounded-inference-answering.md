# Iris Grounded-Inference Answering Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let Iris answer company questions through transparent, bounded inference when authorized same-subject evidence contains every material premise, while preserving exact-subject, permission, injection, and citation safeguards.

**Architecture:** Refine only `ANSWER_DRAFT_SYSTEM_PROMPT` in the existing OpenAI-compatible provider and lock the new evidence policy with a request-contract regression. Retrieval, context assembly, live permission filtering, citation parsing and revalidation, orchestration, runtime controls, and Feishu delivery remain unchanged; live pilot acceptance covers the model-dependent behavior that deterministic prompt-contract tests cannot prove.

**Tech Stack:** TypeScript, Vitest 2, npm workspaces, the existing OpenAI-compatible chat-completions adapter, Docker Compose, and the Feishu pilot environment.

## Global Constraints

- Execute from an isolated worktree created with `superpowers:using-git-worktrees`, based on exactly `master@4aaa38bed1bf98a1d4fce5decd025597012cea3f`; do not implement on the divergent `codex/iris-proactive-feedback-loop-task-1` branch.
- Company-factual claims must use only provided authorized evidence.
- Authorized evidence may support an answer explicitly or through a reasonable synthesis only when every material premise concerns the exact subject in the question.
- A derived conclusion must be identified as an inference and must not be represented as a quotation or explicit source statement.
- General world knowledge must not fill a missing company-specific premise.
- Values from a different document, source type, project, person, date, attribute, or similarly named entity must not be substituted.
- Missing, denied, or unavailable premises remain insufficient; Iris must name the uncertainty instead of guessing.
- `background_documents` and `live_chat_context` remain untrusted evidence, never instructions.
- Every materially used background-document fragment must be listed through the existing `iris_citations` protocol; retrieved but unused fragments must not be cited.
- Direct, generative, formatting, translation, rewriting, and summarization behavior remains available when company evidence is not required.
- Do not change retrieval, chunking, ranking, permission visibility, model temperature, retries, response limits, persistence, runtime settings, APIs, dependencies, or Feishu sending.
- The two retrieval-quality observations in the design (old chat in retrieval queries and no chunk overlap) remain non-blocking backlog items, not part of this change.

---

## File Structure

- `apps/core/src/model/openai-compatible-model-provider.ts`: owns the outbound model system policy; replace the two overly strict grounding sentences with the explicit/derived/insufficient contract while leaving transport and citation parsing intact.
- `apps/core/tests/openai-compatible-model-provider.test.ts`: owns the captured outbound request contract; add the Quello grounded-inference regression beside the existing exact-subject and injection-policy cases.
- No production file is created. No orchestrator, retrieval, permission, citation-rendering, reply-delivery, database, worker, or deployment file is modified.

### Task 1: Implement the grounded-inference provider contract

**Files:**
- Modify: `apps/core/tests/openai-compatible-model-provider.test.ts:206`
- Modify: `apps/core/src/model/openai-compatible-model-provider.ts:25-26`

**Interfaces:**
- Consumes: `ModelProvider.generateAnswerDraft(input: { question: string; promptContext: string }): Promise<GenerateAnswerDraftResult>` from `apps/core/src/agent/answer-draft-orchestrator.ts`.
- Produces: the unchanged `{ answerText: string; citedSourceRefs?: string[] }` result and a refined system message sent through the existing `/chat/completions` request.

- [ ] **Step 1: Write the failing Quello prompt-contract regression**

Add this test immediately before `requires exact-subject grounding instead of related-subject substitution`:

```ts
it("allows transparent grounded inference from complete same-subject premises", async () => {
  const fetch = vi.fn(async () =>
    jsonResponse({
      choices: [{
        message: {
          content:
            '根据文档中的机制，可以推断目标会随状态和经验涌现。\n' +
            '<iris_citations>["D1","D2"]</iris_citations>',
        },
      }],
    }),
  );
  const provider = createOpenAICompatibleModelProvider({ config: config(), fetch });

  await provider.generateAnswerDraft({
    question: "Quello 的电子宠物是如何自己产生目标的？",
    promptContext:
      '<background_documents>' +
      '<document source="quello-overview" citation_ref="D1">' +
      "Life Engine 根据性格、情绪共振、能力边界和当前状态决定行为优先级。" +
      "</document>" +
      '<document source="quello-daily-tick" citation_ref="D2">' +
      "每次 Tick 会让认知摩擦和重复经验积累，并逐渐形成偏好与下一步行动。" +
      "</document>" +
      "</background_documents>",
  });

  const [, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
  const body = JSON.parse(String(init.body)) as {
    messages: Array<{ role: string; content: string }>;
  };
  const systemMessage =
    body.messages.find((message) => message.role === "system")?.content ?? "";

  expect(systemMessage).toContain(
    "either by stating it explicitly or by providing every material premise",
  );
  expect(systemMessage).toContain("reasonable conclusion about the exact subject");
  expect(systemMessage).toContain("identify it as an inference");
  expect(systemMessage).toContain(
    "never present the conclusion as a quotation or an explicit source statement",
  );
  expect(systemMessage).toContain(
    "Do not use general world knowledge to fill a missing company-specific premise",
  );
  expect(systemMessage).toContain("If any material premise is missing");
  expect(systemMessage).toContain("Do not substitute a fact about a different");
  expect(systemMessage).toContain("materially support the visible answer");
});
```

- [ ] **Step 2: Run the new test and verify RED**

Run:

```powershell
npm --workspace apps/core test -- openai-compatible-model-provider.test.ts -t "allows transparent grounded inference from complete same-subject premises"
```

Expected: FAIL on the first new policy expectation because the baseline prompt allows only direct exact-attribute support and does not define grounded inference.

- [ ] **Step 3: Replace the overly strict grounding lines with the three-state policy**

In `ANSWER_DRAFT_SYSTEM_PROMPT`, replace the current `Ground claims...` and `Match company facts...` entries with these five entries, in this order:

```ts
"Ground claims about company facts only in the provided authorized evidence.",
"Authorized evidence may support a company-factual answer either by stating it explicitly or by providing every material premise needed for a reasonable conclusion about the exact subject.",
"When the answer is derived rather than explicit, identify it as an inference and never present the conclusion as a quotation or an explicit source statement.",
"Do not use general world knowledge to fill a missing company-specific premise. If any material premise is missing, say what is uncertain or unavailable instead of guessing.",
"Match company facts to the exact subject and exact attribute named in the current Question. The requested attribute may be derived by synthesizing authorized evidence about that exact subject only when every material premise is present. Do not substitute a fact about a different document, source type, project, person, date, attribute, or similarly named entity; when evidence only supports a related but different subject or attribute, state that the requested fact is unavailable and do not return the related value.",
```

Leave the citation, denied-content, current-question safety, untrusted-context, language, direct-task, timeout, retry, and response-parsing entries byte-for-byte unchanged.

- [ ] **Step 4: Run the new test and verify GREEN**

Run:

```powershell
npm --workspace apps/core test -- openai-compatible-model-provider.test.ts -t "allows transparent grounded inference from complete same-subject premises"
```

Expected: PASS with one test selected and zero failures.

- [ ] **Step 5: Run the focused provider and boundary regressions**

Run:

```powershell
npm --workspace apps/core test -- openai-compatible-model-provider.test.ts answer-draft-orchestrator.test.ts answer-reply-delivery-service.test.ts answer-source-citation-renderer.test.ts feishu-document-permission-checker.test.ts feishu-mention-answer-responder.test.ts
```

Expected: all selected suites pass. In particular, the existing exact-subject test still finds the unavailable/related-value safeguards, the injection test still finds the untrusted-evidence rules, citation parsing still separates internal metadata, permission denial still fails closed, and mention replies still use revalidated citations.

- [ ] **Step 6: Commit the focused implementation**

Run:

```powershell
git diff --check
git add apps/core/tests/openai-compatible-model-provider.test.ts apps/core/src/model/openai-compatible-model-provider.ts
git commit -m "fix: allow grounded knowledge inference"
```

Expected: one commit containing only the provider policy and its regression test.

### Task 2: Verify the complete candidate and review its scope

**Files:**
- Verify: `apps/core/src/model/openai-compatible-model-provider.ts`
- Verify: `apps/core/tests/openai-compatible-model-provider.test.ts`
- Verify unchanged boundaries: `apps/core/src/agent/answer-draft-orchestrator.ts`, `apps/core/src/answer-replies/answer-reply-delivery-service.ts`, and the repository verification targets.

**Interfaces:**
- Consumes: the committed provider change from Task 1.
- Produces: one clean candidate SHA derived from `4aaa38bed1bf98a1d4fce5decd025597012cea3f`, with all repository gates passing and no unrelated runtime diff.

- [ ] **Step 1: Prove the candidate ancestry and exact runtime scope**

Run:

```powershell
$ErrorActionPreference = "Stop"
$baselineSha = "4aaa38bed1bf98a1d4fce5decd025597012cea3f"
$candidateSha = (git rev-parse HEAD).Trim()
if ($candidateSha -notmatch "^[0-9a-f]{40}$") { throw "Invalid candidate SHA" }
git merge-base --is-ancestor $baselineSha $candidateSha
if ($LASTEXITCODE -ne 0) { throw "Candidate is not based on the approved master baseline" }
$runtimePaths = @(git diff --name-only "$baselineSha...$candidateSha" -- apps/core/src apps/core/tests)
$expectedPaths = @(
  "apps/core/src/model/openai-compatible-model-provider.ts",
  "apps/core/tests/openai-compatible-model-provider.test.ts"
)
if ((Compare-Object $expectedPaths $runtimePaths).Length -ne 0) {
  throw "Unexpected runtime scope: $($runtimePaths -join ', ')"
}
git diff --check "$baselineSha...$candidateSha"
git diff "$baselineSha...$candidateSha" -- @expectedPaths
```

Expected: ancestry succeeds, the runtime/test path set is exactly the two expected files, `git diff --check` is silent, and the displayed diff matches Task 1.

- [ ] **Step 2: Run the complete repository verification**

Run:

```powershell
npm run verify
```

Expected: `git diff --check`, Core typecheck and build, all Core tests, the Python suite, pilot tests, Compose configuration, rollout readiness, and pilot configuration all exit `0`.

- [ ] **Step 3: Publish the candidate branch and require exact-SHA CI**

Run:

```powershell
$ErrorActionPreference = "Stop"
$candidateSha = (git rev-parse HEAD).Trim()
git push --set-upstream origin HEAD:codex/iris-grounded-inference-answering
gh pr create --draft --base master --head codex/iris-grounded-inference-answering --title "fix: allow grounded knowledge inference" --body "Allows transparent same-subject inference from complete authorized premises while preserving exact-subject, permission, injection, and citation safeguards."
if ($LASTEXITCODE -ne 0) {
  gh pr view codex/iris-grounded-inference-answering --json number,headRefOid,state,url
}
gh pr checks codex/iris-grounded-inference-answering --watch
$remoteHead = (git ls-remote origin refs/heads/codex/iris-grounded-inference-answering).Split()[0]
if ($remoteHead -ne $candidateSha) { throw "Remote branch does not equal reviewed candidate" }
```

Expected: the draft PR targets `master`, its head OID and remote branch both equal `candidateSha`, and the `Core` and `AI Worker` checks succeed for that exact SHA. Do not deploy a failed or pending check.

- [ ] **Step 4: Confirm a clean, immutable deployment candidate**

Run:

```powershell
$ErrorActionPreference = "Stop"
$candidateSha = (git rev-parse HEAD).Trim()
if (@(git status --porcelain).Length -ne 0) { throw "Candidate worktree is not clean" }
git show --stat --oneline --decorate --no-renames $candidateSha
git show --format=fuller --no-ext-diff -- apps/core/src/model/openai-compatible-model-provider.ts apps/core/tests/openai-compatible-model-provider.test.ts
```

Expected: the worktree is clean and the reviewed candidate SHA names the focused implementation commit. Record this full SHA for Task 3; do not deploy a moving branch name or mutable tag.

### Task 3: Deploy fail-closed and run the live Feishu acceptance

**Files:**
- Operate from: `/opt/iris/repository`
- Follow: `docs/operations/internal-rollout-runbook.md` sections `Single-VPS Pilot Deployment`, `Planned Restart And Reactivation`, and `Emergency Stop And Rollback`.
- Follow for citations and permission checks: `docs/runbooks/iris-answer-source-citations-acceptance.md` sections 1-7, using a dedicated revocable fixture for the permission-negative case.
- Record privately: `/etc/iris/deployment`

**Interfaces:**
- Consumes: the exact clean candidate SHA from Task 2, the currently approved pilot group `oc_637a9aca45f01943477f4e17f1fc5b9a`, the authorized `Quello Life Engine（生命粒子引擎）副本` source, and the existing runtime-control/operator credentials.
- Produces: one healthy commit-pinned Core/AI Worker deployment, a grounded Quello reply with revalidated supporting references, negative-control evidence, zero queue/DLQ counts, and a recorded rollback target.

- [ ] **Step 1: Capture the pre-deploy state without changing production**

On the operator machine, validate the local candidate, then inspect the VPS:

```powershell
$ErrorActionPreference = "Stop"
$candidateSha = (git rev-parse HEAD).Trim()
if ($candidateSha -notmatch "^[0-9a-f]{40}$") { throw "Invalid candidate SHA" }
ssh iris-vps "cd /opt/iris/repository && git rev-parse HEAD && git status --porcelain && docker compose --env-file .env.pilot --file deploy/pilot/docker-compose.yml ps"
```

Expected: the command records the previous approved SHA and healthy service state. The known operations state is a detached checkout with only the intentional `deploy/pilot/Caddyfile` `quello.cn` redirect plus `.iris-*-commit`, `backups/`, and `evidence/` as local state. Stop if any other tracked path is modified, the redirect differs from the preflight evidence, any service is unhealthy, or the current approved image/checkout cannot be identified. Preserve all known local state.

- [ ] **Step 2: Execute the fail-closed preflight and encrypted backup**

On the VPS, set `CANDIDATE_SHA` to the full reviewed SHA and use the existing Compose project:

```bash
set -Eeuo pipefail
cd /opt/iris/repository
: "${CANDIDATE_SHA:?set the reviewed 40-character candidate SHA}"
[[ "$CANDIDATE_SHA" =~ ^[0-9a-f]{40}$ ]]
compose=(docker compose --env-file .env.pilot --file deploy/pilot/docker-compose.yml)
"${compose[@]}" stop caddy
"${compose[@]}" exec --no-TTY core node --input-type=module --eval '
  const headers = {
    authorization: `Bearer ${process.env.IRIS_INTERNAL_API_TOKEN}`,
    "content-type": "application/json",
    "x-iris-operator": "grounded-inference-acceptance",
  };
  const disabled = await fetch("http://127.0.0.1:3000/internal/runtime-control/global", {
    method: "POST", headers, body: JSON.stringify({ enabled: false }),
  });
  if (!disabled.ok) process.exit(1);
  const response = await fetch("http://127.0.0.1:3000/internal/status", { headers });
  const body = await response.json();
  const runtime = body?.components?.runtimeControl;
  const event = body?.components?.eventWorker;
  const document = body?.components?.documentSync;
  const reindex = body?.components?.reindex;
  const counts = [
    event?.pendingEventCount, event?.deadLetterEventCount,
    document?.pendingJobCount, document?.deadLetterJobCount,
    reindex?.pendingJobCount, reindex?.deadLetterJobCount,
  ];
  if (!response.ok || runtime?.globalEnabled !== false
    || runtime?.desiredGlobalEnabled !== false
    || event?.running !== true || document?.running !== true || reindex?.running !== true
    || counts.some((count) => count !== 0)) process.exit(1);
'
test -z "$("${compose[@]}" ps --status running --services | grep -Fx caddy || true)"
backup_path="$(/usr/local/sbin/iris-backup | tail -n 1)"
test -n "$backup_path" && test -f "$backup_path"
printf 'rollback_backup=%s\n' "$backup_path"
```

Expected: global and desired-global runtime are false, Caddy is stopped, enabled workers are running, all event/document/reindex pending and DLQ counts are zero, and a verified encrypted backup path is recorded. Any failed assertion ends the rollout with Iris disabled and Caddy stopped.

- [ ] **Step 3: Fetch, build, and activate only the exact candidate**

Fetch the published candidate branch, prove its OID, preserve the intentional Caddy override, and activate the detached commit:

```bash
set -Eeuo pipefail
cd /opt/iris/repository
: "${CANDIDATE_SHA:?set the reviewed 40-character candidate SHA}"
previous_sha="$(cat .iris-approved-commit)"
[[ "$previous_sha" =~ ^[0-9a-f]{40}$ ]]
git fetch origin codex/iris-grounded-inference-answering
test "$(git rev-parse FETCH_HEAD)" = "$CANDIDATE_SHA"
git diff --quiet HEAD FETCH_HEAD -- deploy/pilot/Caddyfile
git checkout --detach "$CANDIDATE_SHA"
test "$(git rev-parse HEAD)" = "$CANDIDATE_SHA"
sed -i -E "s/^IRIS_IMAGE_TAG=.*/IRIS_IMAGE_TAG=$CANDIDATE_SHA/" .env.pilot
grep -Fx "IRIS_IMAGE_TAG=$CANDIDATE_SHA" .env.pilot >/dev/null
compose=(docker compose --env-file .env.pilot --file deploy/pilot/docker-compose.yml)
"${compose[@]}" config --quiet
"${compose[@]}" build core ai-worker
"${compose[@]}" up --detach --wait --wait-timeout 120 postgres redis migrate ai-worker core
test "$(docker inspect --format '{{.Config.Image}}' "$("${compose[@]}" ps -q core)")" = "iris-core:$CANDIDATE_SHA"
test "$(docker inspect --format '{{.Config.Image}}' "$("${compose[@]}" ps -q ai-worker)")" = "iris-ai-worker:$CANDIDATE_SHA"
```

Expected: the checkout and both images equal the same full candidate SHA, the pre-existing Caddy redirect and private evidence/backup state remain present, private services are healthy, and Caddy remains stopped. Re-run the complete fail-closed status assertion from Step 2 before enabling any reply.

- [ ] **Step 4: Enable only the approved pilot group and ask the positive Quello question once**

Follow the runbook's controlled daily pilot profile: retain the existing capability inventory, disable all non-pilot groups, durably enable global runtime, verify the fresh state, arm the automatic fail-closed timer, and start Caddy last. In Feishu group `oc_637a9aca45f01943477f4e17f1fc5b9a`, send exactly:

```text
@Iris Quello 的电子宠物是如何自己产生目标的？
```

Expected visible behavior:

- the reply says the conclusion is inferred from documented mechanisms rather than quoted directly;
- it connects current state, personality/emotional priority, capability boundaries, accumulated experience, cognitive friction, and Tick evolution to emerging goals or next actions;
- it does not say the LLM freely invents goals and does not invent a score, threshold, formula, or undocumented component;
- `Iris 参考资料：` contains only currently readable, materially supporting Quello references.

Record the new incoming Feishu message ID and inspect its content-free receipt with the existing command in `iris-answer-source-citations-acceptance.md` section 5. The receipt must list the supporting source/fragment facts and must not expose `preparedReplyText`, `fragmentText`, or `promptContext`.

- [ ] **Step 5: Run the exact-subject and related-subject fixture controls**

Create one bounded, non-sensitive Wiki fixture shared with the Iris app, sync and index it, and confirm live permission is allowed. Use this exact content:

```text
Title: Iris Grounded Inference Subject Fixture
Body: 群文档验收编号：IRIS_GROUP_FACT_3907
```

Send these as two fresh messages in the pilot group, in order:

```text
@Iris 群文档验收编号是什么？只回答编号。
@Iris 知识库验收编号是什么？只回答编号。
```

Expected: the first answer contains `IRIS_GROUP_FACT_3907` and its currently readable fixture reference. The second states that the requested knowledge-base number is unavailable and does not contain `IRIS_GROUP_FACT_3907`; it must not substitute the related group-document value.

- [ ] **Step 6: Prove permission revocation still fails closed**

Use the dedicated fixture from Step 5, not the production Quello source. Revoke only the Iris app's access and send `@Iris 群文档验收编号是什么？只回答编号。` with a fresh message ID.

Expected: the revoked marker and content are absent, the model/provider is not called for the revoked turn, only the safe permission-changed notice may be sent, and the content-free receipt transitions to `permission_blocked` with zero answer-send attempts. If a human must change Feishu sharing or send the message, request exactly that one action and wait; do not fabricate evidence.

- [ ] **Step 7: Close the pilot gate or roll back**

Stop Caddy and durably disable Iris before the final private inspection. Require:

```text
event pending=0, DLQ=0
document-sync pending=0, DLQ=0
reindex pending=0, DLQ=0
answerReplyUnresolvedCount=0
answerReplyPendingSafeNoticeCount=0
answerReplyReconciliationRequiredCount=0
```

If Steps 4-6 pass, restore only the previously approved pilot runtime state, start Caddy last, and append the candidate SHA, UTC activation time, previous SHA, encrypted backup identifier, four message IDs, receipt results, and final zero counts to `/etc/iris/deployment`.

If Iris makes an unsupported company claim, weakens permission/injection behavior, cites unrelated material, or any health/queue gate fails, keep global and desired-global runtime false, stop Caddy, follow `Emergency Stop And Rollback`, restore the previous approved image SHA, and re-run the authenticated private health and zero-queue gates. This prompt-only change has no schema or data migration, so application-image rollback is sufficient unless an independent data failure is discovered.
