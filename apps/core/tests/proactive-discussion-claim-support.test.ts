import { expect, test, vi } from 'vitest';
import { reviewPdClaimSupport } from '../src/proactive-discussion/claim-support.js';
import { pdAssessment } from './fixtures/proactive-discussion.js';
import type { OpenAICompatibleChatCompletionsClient } from '../src/model/openai-compatible-chat-completions-client.js';
function setup(verdicts: string[]) {
 const client={complete:vi.fn<OpenAICompatibleChatCompletionsClient['complete']>(async()=>JSON.stringify({verdict:verdicts.shift(),reason:'PRIVATE provider diagnosis: opposite is true'}))};
 return client;
}
test('sends each complete prose field independently with only original source texts',async()=>{
 const a=pdAssessment();const client=setup(['supported','supported','supported']);
 expect(await reviewPdClaimSupport(client,a,[{text:'original source'}])).toEqual([]);
 expect(client.complete).toHaveBeenCalledTimes(3);
 expect(client.complete.mock.calls.map(c=>JSON.parse(c[0][1]!.content))).toEqual(
   ['observation','reasoning','suggestion'].map(field=>({sources:['original source'],claim:a[field as 'observation']})));
});
test('both unsupported verdicts withhold permission without asserting contradiction or leaking diagnoses',async()=>{
 const client=setup(['supported','contradicted','insufficient']);
 const result=await reviewPdClaimSupport(client,pdAssessment(),[{text:'original source'}]);
 expect(result).toEqual(['reasoning','suggestion']);
 expect(JSON.stringify(result)).not.toContain('PRIVATE');
});
test('malformed verdict cannot approve a sentence',async()=>{
 await expect(reviewPdClaimSupport(setup(['unknown']),pdAssessment(),[{text:'source'}])).rejects.toThrow('claim support review was invalid');
});
test('cancellation prevents another claim call',async()=>{
 const client=setup(['supported','supported','supported']);let checks=0;
 await expect(reviewPdClaimSupport(client,pdAssessment(),[{text:'source'}],async()=>{if(++checks===2)throw Error('stopped');})).rejects.toThrow('stopped');
 expect(client.complete).toHaveBeenCalledTimes(1);
});
