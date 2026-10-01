import { readFileSync } from 'node:fs';
import { expect, test, vi } from 'vitest';
import { createPdModel } from '../src/proactive-discussion/model.js';
import type { OpenAICompatibleChatCompletionsClient } from '../src/model/openai-compatible-chat-completions-client.js';

test('replays the original five arithmetic completions after Chinese count receipt correction, without HTTP', async () => {
  const report = JSON.parse(readFileSync(new URL('../../../docs/development/evidence/iris-source-focus-20261001.json', import.meta.url), 'utf8'));
  expect(report.executionPassed).toBe(false);
  const recorded = report.completions.filter((entry: { caseId: string }) => entry.caseId === 'arithmetic');
  expect(recorded).toHaveLength(5);
  let index = 0;
  const client = { complete: vi.fn<OpenAICompatibleChatCompletionsClient['complete']>(async (messages, options) => {
    const entry = recorded[index++];
    expect(options!.responseFormat!.json_schema.name).toBe(entry.stage);
    if (index === 1) expect(messages).toEqual(entry.messages);
    return entry.content;
  }) };
  const context = JSON.parse(readFileSync(new URL('./fixtures/source-focus-arithmetic-context.json', import.meta.url), 'utf8'));
  const model = createPdModel({ client, canonicalOpinion: true, sourceBoundIdentity: true });
  const assessment = await model.assess(context);
  const pair = await model.render({ context, assessment });
  expect(index).toBe(5);
  expect(pair).not.toBeNull();
  expect(pair!.assessment.uncertainty).toBe('qualified_inference');
  const finalInput = JSON.parse(recorded[4].messages[1].content);
  expect(pair!.draft).toEqual(finalInput.draft);
  expect(pair!.assessment).toEqual(finalInput.assessment);
  expect(pair!.draft.text).toContain('16万元');
  expect(pair!.draft.text).toContain('6万元');
});
