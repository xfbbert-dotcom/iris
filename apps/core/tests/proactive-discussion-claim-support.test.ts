import { expect, test, vi } from 'vitest';
import { reviewPdClaimSupport, splitPdClaimSentences } from '../src/proactive-discussion/claim-support.js';
import { pdAssessment } from './fixtures/proactive-discussion.js';
import type { OpenAICompatibleChatCompletionsClient } from '../src/model/openai-compatible-chat-completions-client.js';
function setup(verdicts: string[]) {
 const client={complete:vi.fn<OpenAICompatibleChatCompletionsClient['complete']>(async()=>JSON.stringify({verdict:verdicts.shift(),reason:'PRIVATE provider diagnosis: opposite is true'}))};
 return client;
}
test('sends each complete sentence independently with only original source texts',async()=>{
 const a=pdAssessment(); a.observation='事实一。事实二。'; const client=setup(['supported','supported','supported','supported']);
 expect(await reviewPdClaimSupport(client,a,[{text:'original source'}])).toEqual([]);
 expect(client.complete).toHaveBeenCalledTimes(4);
 expect(client.complete.mock.calls.map(c=>JSON.parse(c[0][1]!.content))).toEqual(
   ['事实一。','事实二。',a.reasoning,a.suggestion].map(claim=>({sources:['original source'],claim})));
});
test('both unsupported verdicts withhold permission without asserting contradiction or leaking diagnoses',async()=>{
 const client=setup(['supported','contradicted','insufficient']);
 const result=await reviewPdClaimSupport(client,pdAssessment(),[{text:'original source'}]);
 expect(result).toEqual([{field:'reasoning',quote:pdAssessment().reasoning},{field:'suggestion',quote:pdAssessment().suggestion}]);
 expect(JSON.stringify(result)).not.toContain('PRIVATE');
});
test('sentence boundaries preserve conditions, quoted punctuation, decimals and every character',()=>{
 const text='原话“如果接口失败，会怎样？”。如果有阻塞，可能延期；但仍需核实。\n成本1.5万元！';
 const parts=splitPdClaimSentences(text);
 expect(parts).toEqual(['原话“如果接口失败，会怎样？”。','如果有阻塞，可能延期；但仍需核实。','\n成本1.5万元！']);
 expect(parts.join('')).toBe(text);
 expect(splitPdClaimSentences("原话'若阻塞，会怎样？'尚未核实。Don't assume!继续核实。"))
   .toEqual(["原话'若阻塞，会怎样？'尚未核实。","Don't assume!","继续核实。"]);
});
test('bounded claim count rejects before any model request',async()=>{
 const a=pdAssessment();a.reasoning='句子。'.repeat(17);const client=setup([]);
 await expect(reviewPdClaimSupport(client,a,[{text:'source'}])).rejects.toThrow('too many claim sentences');
 expect(client.complete).not.toHaveBeenCalled();
});
test('malformed verdict cannot approve a sentence',async()=>{
 await expect(reviewPdClaimSupport(setup(['unknown']),pdAssessment(),[{text:'source'}])).rejects.toThrow('claim support review was invalid');
});
test('cancellation prevents another claim call',async()=>{
 const client=setup(['supported','supported','supported']);let checks=0;
 await expect(reviewPdClaimSupport(client,pdAssessment(),[{text:'source'}],async()=>{if(++checks===2)throw Error('stopped');})).rejects.toThrow('stopped');
 expect(client.complete).toHaveBeenCalledTimes(1);
});
