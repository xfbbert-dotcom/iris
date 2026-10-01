import { readFileSync } from 'node:fs';
import { expect, test, vi } from 'vitest';
import { createPdModel } from '../src/proactive-discussion/model.js';
import type { OpenAICompatibleChatCompletionsClient } from '../src/model/openai-compatible-chat-completions-client.js';

test('replays the original four update completions after clause boundary correction, without HTTP', async () => {
  const report = JSON.parse(readFileSync(new URL('../../../docs/development/evidence/iris-assessment-opinion-20261001.json', import.meta.url), 'utf8'));
  expect(report.executionPassed).toBe(false);
  const recorded = report.completions.filter((entry: { caseId: string }) => entry.caseId === 'material-update');
  expect(recorded).toHaveLength(4);
  let index = 0;
  const client = { complete: vi.fn<OpenAICompatibleChatCompletionsClient['complete']>(async (messages, options) => {
    const entry = recorded[index++];
    expect(options!.responseFormat!.json_schema.name).toBe(entry.stage);
    if (index === 1) expect(messages).toEqual(entry.messages);
    return entry.content;
  }) };
  const context = JSON.parse(readFileSync(new URL('./fixtures/assessment-opinion-update-context.json', import.meta.url), 'utf8'));
  const model = createPdModel({ client, canonicalOpinion: true, sourceBoundIdentity: true, assessmentOpinion: true });
  const assessment = await model.assess(context);
  const pair = await model.render({ context, assessment });
  expect(index).toBe(4);
  expect(pair).not.toBeNull();
  expect(pair!.assessment.uncertainty).toBe('qualified_inference');
  const finalInput = JSON.parse(recorded[3].messages[1].content);
  expect(pair!.draft).toEqual(finalInput.draft);
  expect(pair!.assessment).toEqual(finalInput.assessment);
  expect(pair!.draft.text).toContain('24万');
  expect(pair!.draft.text).toContain('14万');
});
