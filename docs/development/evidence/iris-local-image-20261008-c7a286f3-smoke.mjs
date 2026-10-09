import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { compilePdOpinionPlan } from '/app/apps/core/dist/proactive-discussion/opinion-plan.js';
import { buildPdOpinionSourceCatalog, resolvePdOpinionSourceSelection, pdOpinionSelectionFormat } from '/app/apps/core/dist/proactive-discussion/source-selection.js';
import { createPdModel } from '/app/apps/core/dist/proactive-discussion/model.js';

assert.equal(typeof createPdModel, 'function');
const evidence = [{ ref: 'premise', text: '版本A尚未验收。' },
  { ref: 'decision', text: '现在就向客户承诺，文档全部事项明天完成。' }];
const catalog = buildPdOpinionSourceCatalog(evidence);
assert.deepEqual(catalog.map(source => source.units.map(unit => unit.text).join('')), evidence.map(source => source.text));
const selection = { kind: 'dependency', premise: { sourceRef: 'premise', startUnit: 0, endUnit: catalog[0].units.length - 1 },
  decision: { sourceRef: 'decision', startUnit: 0, endUnit: catalog[1].units.length - 1 }, changeExplanation: 'offline contract check' };
const resolved = resolvePdOpinionSourceSelection(selection, catalog);
assert.equal(resolved.decision.quote, evidence[1].text);
const pair = compilePdOpinionPlan(resolved, true, evidence);
assert.ok(pair.prose.draftText.includes('现在就向客户承诺'));
assert.equal(pair.prose.suggestion, '建议先暂缓上述决定，补齐所依赖的验证或确认，明确可执行的范围和条件，再确定推进安排。');
assert.throws(() => resolvePdOpinionSourceSelection({ ...selection, verificationTarget: selection.premise }, catalog));
assert.throws(() => resolvePdOpinionSourceSelection({ ...selection, decision: { sourceRef: 'decision', quote: evidence[1].text } }, catalog));
for (const reason of ['no_material_issue', 'insufficient_basis', 'already_handled']) {
  assert.equal(compilePdOpinionPlan(resolvePdOpinionSourceSelection({ kind: 'no_intervention', reason }, catalog), true, evidence), null);
}
for (const repair of [false, true]) {
  const branches = pdOpinionSelectionFormat(repair).json_schema.schema.anyOf;
  assert.ok(branches.some(branch => branch.properties.kind.enum[0] === 'no_intervention'));
  const dependency = branches.find(branch => branch.properties.kind.enum[0] === 'dependency');
  assert.deepEqual(dependency.properties.decision.required, ['sourceRef', 'startUnit', 'endUnit']);
  assert.equal(dependency.properties.verificationTarget, undefined);
}
for (const name of ['vitest', 'typescript', 'vite']) assert.equal(existsSync('/app/node_modules/' + name), false);
for (const name of ['0059_proactive_discussion.sql', '0060_proactive_discussion_prose_sources.sql']) {
  assert.ok(existsSync('/app/apps/core/migrations/' + name));
}
console.log(JSON.stringify({ kind: 'iris-core-offline-image-smoke', ok: true, node: process.version,
  platform: process.platform, architecture: process.arch,
  fastify: JSON.parse(readFileSync('/app/node_modules/fastify/package.json', 'utf8')).version,
  sourceSelectionModule: true, exactContinuousSourceReconstruction: true, dependencyDecisionGate: true,
  obsoleteTargetRejected: true, quoteOnlyLiveSelectionRejected: true, withdrawalReasonsChecked: 3,
  generationAndRepairSchemaChecked: true, developmentPackagesAbsent: ['vitest', 'typescript', 'vite'],
  applicationServerStarted: false, providerRequests: 0, feishuRequests: 0, network: 'none' }));
