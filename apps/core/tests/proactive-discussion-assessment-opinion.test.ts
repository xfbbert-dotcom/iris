import { expect, test, vi } from 'vitest';
import { createPdModel } from '../src/proactive-discussion/model.js';
import { pdAssessment, pdContext, pdReviewFieldChecks, pdSkipAssessment } from './fixtures/proactive-discussion.js';
import type { OpenAICompatibleChatCompletionsClient } from '../src/model/openai-compatible-chat-completions-client.js';

function candidate() {
  const a = pdAssessment();
  a.issueRef = { kind: 'new', description: pdContext().items[1]!.text };
  return a;
}
function setup(supported = true, assessment = candidate()) {
  const client = { complete: vi.fn<OpenAICompatibleChatCompletionsClient['complete']>(async (messages, options) => {
    const name = options!.responseFormat!.json_schema.name;
    if (name.endsWith('_assessment')) return JSON.stringify({ assessment });
    const input = JSON.parse(messages[1]!.content);
    if (name.endsWith('_scope_review')) return JSON.stringify({ fieldChecks: pdReviewFieldChecks(), supported, reason: 'fixture', requiredNumbers: [], adviceQuote: input.draft.text });
    if (name.endsWith('_pair_repair')) return JSON.stringify({ opinion: { segments: [
      { role: 'observation', text: assessment.observation }, { role: 'reasoning', text: assessment.reasoning },
      { role: 'suggestion', text: assessment.suggestion },
    ], uncertainty: assessment.uncertainty } });
    throw new Error('unexpected second author');
  }) };
  const model = createPdModel({ client, canonicalOpinion: true, sourceBoundIdentity: true, assessmentOpinion: true });
  return { client, model };
}
test('assessment prose becomes the reviewed draft without a second author call', async () => {
  const a = candidate(); const s = setup();
  const pair = await s.model.render({ context: pdContext(), assessment: a });
  expect(pair!.draft.text).toBe(a.observation + a.reasoning + a.suggestion);
  expect(pair!.assessment.reasoning).toBe(a.reasoning);
  expect(s.client.complete).toHaveBeenCalledTimes(1);
  const input = JSON.parse(s.client.complete.mock.calls[0]![0][1]!.content);
  expect(input.identityTarget.issueRef.sourceFocus.sourceQuote).toBe(a.issueRef!.kind === 'new' && a.issueRef!.description);
});
test('skip does not create or review a draft', async () => {
  const s = setup(); expect(await s.model.render({ context: pdContext(), assessment: pdSkipAssessment() })).toBeNull();
  expect(s.client.complete).not.toHaveBeenCalled();
});
test('rejection still gets only one correction and a complete rejecting final review', async () => {
  const s = setup(false); expect(await s.model.render({ context: pdContext(), assessment: candidate() })).toBeNull();
  expect(s.client.complete.mock.calls.map(call => call[1]!.responseFormat!.json_schema.name)).toEqual([
    'iris_proactive_discussion_scope_review', 'iris_proactive_discussion_canonical_pair_repair', 'iris_proactive_discussion_scope_review',
  ]);
});
test('oversized projected opinions get at most two assessment attempts, never a second author fallback', async () => {
  const a = candidate(); a.reasoning = '长'.repeat(1200); const s = setup(true, a);
  await expect(s.model.assess(pdContext())).rejects.toThrow('assessment was invalid');
  expect(s.client.complete).toHaveBeenCalledTimes(2);
});
test('direct render also rejects oversized projection before any review call', async () => {
  const a = candidate(); a.reasoning = '长'.repeat(1200); const s = setup(true, a);
  await expect(s.model.render({ context: pdContext(), assessment: a })).rejects.toThrow('draft was invalid');
  expect(s.client.complete).not.toHaveBeenCalled();
});
