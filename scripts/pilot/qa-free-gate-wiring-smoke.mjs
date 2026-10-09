// Local synthetic wiring only: actual compiled QA components and loopback HTTP,
// injected provider responses, context retrieval and delivery. No real credentials.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp, readFile, readdir, rename, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {basename, join, resolve, sep} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createFreeGate, FREE_GATE_TIMING} from './proactive-discussion-free-gate.mjs';

const key='qa-wiring-placeholder-not-a-key', upstream='https://qa-wiring.invalid/v1/chat/completions';
const sha=b=>createHash('sha256').update(b).digest('hex');
const pause=ms=>new Promise(r=>setTimeout(r,ms));
const prior='联调还没完成，建议先完成联调，再决定是否承诺交付。';
const explanation='我的意思是：先完成联调，再根据结果确认交付承诺。';
const directPlan={taskMode:'direct_task',evidenceState:null,premises:[],proposedAnswer:null,missingInformation:[],confidence:null};
const factPlan={taskMode:'company_fact',evidenceState:'explicit',premises:[{citationRef:'C1',statement:'接口尚未联调。'}],proposedAnswer:'接口尚未联调。',missingInformation:[],confidence:'high'};

async function main() {
  const args=process.argv.slice(2);
  assert.ok(args.length===0 || (args.length===2 && args[0]==='--core-dist'));
  const dist=resolve(args[1]??'apps/core/dist');
  const load=async path=>import(pathToFileURL(join(dist,path+'.js')).href);
  const {readModelProviderConfig}=await load('config/env');
  const {createDefaultRuntimeConfig}=await load('config/runtime-config');
  const {RuntimeController}=await load('admin/runtime-controller');
  const {createOpenAICompatibleChatCompletionsClient}=await load('model/openai-compatible-chat-completions-client');
  const {createOpenAICompatibleModelProvider}=await load('model/openai-compatible-model-provider');
  const {createOpenAICompatibleRequestContextRouter}=await load('model/openai-compatible-request-context-router');
  const {createOpenAICompatibleEvidencePlanner}=await load('model/openai-compatible-evidence-planner');
  const {createOpenAICompatibleGroundedAnswerRenderer}=await load('model/openai-compatible-grounded-answer-renderer');
  const {createAnswerDraftOrchestrator}=await load('agent/answer-draft-orchestrator');
  const {createFeishuMentionAnswerResponder}=await load('conversation/feishu-mention-answer-responder');
  const parent=await mkdtemp(join(tmpdir(),'iris-qa-wiring-'));
  const realFetch=globalThis.fetch, allowed=new Set();
  globalThis.fetch=(url,init)=>{
    assert.ok(typeof url==='string' && allowed.has(url),'non-loopback network forbidden');
    return realFetch(url,{...init,redirect:'error'});
  };
  const checks=[];
  try {
    for (const permit of [false,true]) {
      const sent=[],outbound=[],permits=[],answers=[];
      const completions=[JSON.stringify({smoke:true}),JSON.stringify({route:'contextual'}),JSON.stringify(directPlan),explanation,
        JSON.stringify({route:'contextual'}),JSON.stringify(factPlan),JSON.stringify({answerText:'接口尚未联调。',evidenceState:'explicit',confidence:'high'})];
      const gate=createFreeGate({profile:'pd-and-qa',sessionParent:parent,apiKey:key,upstreamUrl:upstream,
        permitWaitMs:permit?3000:150,windowMs:15000,
        fetchImpl:async(url,init)=>{
          assert.equal(url,upstream);assert.equal(init.headers.authorization,`Bearer ${key}`);
          const bytes=Buffer.from(init.body);sent.push(bytes);
          assert.deepEqual(bytes,outbound[sent.length-1]);
          const content=completions.shift();assert.equal(typeof content,'string');
          return new Response(JSON.stringify({model:'qwen3.8-max',choices:[{finish_reason:'stop',message:{role:'assistant',content}}],usage:{total_tokens:1}}));
        }});
      let monitoring=true;
      try {
        await gate.start();
        const baseUrl=`http://127.0.0.1:${gate.server.address().port}/v1`, endpoint=baseUrl+'/chat/completions';
        allowed.add(endpoint);
        const monitor=(async()=>{
          const handled=new Set();
          while(monitoring) {
            for(const name of await readdir(gate.sessionDir)) {
              if(!name.startsWith('pending-') || handled.has(name)) continue;
              let p;try {p=JSON.parse(await readFile(join(gate.sessionDir,name),'utf8'));} catch {continue;}
              handled.add(name);
              assert.equal(p.profile,'pd-and-qa');assert.equal(p.requestHash,sha(outbound[handled.size-1]));
              if(!permit) continue;
              const target=join(gate.sessionDir,`permit-${p.requestId}.json`);
              const proof={...p,remainingTokens:200000,observedAt:new Date().toISOString(),expiresAt:new Date(Date.now()+3000).toISOString(),freeExhaustionStop:true};
              await writeFile(target+'.tmp',JSON.stringify(proof),{flag:'wx',mode:0o600});await rename(target+'.tmp',target);permits.push(p.responseMode);
            }
            await pause(5);
          }
        })();
        // Handle monitor rejection immediately while awaiting requests.
        let monitorError;const observedMonitor=monitor.catch(error=>{monitorError=error;});
        try {
          const config=readModelProviderConfig({IRIS_MODEL_PROVIDER:'openai-compatible',IRIS_MODEL_BASE_URL:baseUrl,
            IRIS_MODEL_API_KEY:key,IRIS_MODEL_NAME:'qwen3.8-max',IRIS_MODEL_TIMEOUT_MS:String(FREE_GATE_TIMING.clientTimeoutMs),
            IRIS_MODEL_STRUCTURED_OUTPUT_MODE:'json_object',IRIS_MODEL_MAX_TOKENS:'4096',IRIS_MODEL_ENABLE_THINKING:'false'});
          assert.equal(config.timeoutMs,120000);assert.equal(config.maxTokens,4096);assert.equal(config.enableThinking,false);
          const client=createOpenAICompatibleChatCompletionsClient({config,fetch:(url,init)=>{
            outbound.push(Buffer.from(init.body));return globalThis.fetch(url,init);
          }});
          const runtime=new RuntimeController(createDefaultRuntimeConfig({IRIS_ANSWER_ALLOWED_GROUP_IDS:'qa-smoke-group'}));
          assert.equal(runtime.canGenerateAnswerDraft({}),false);
          const sourceMessages=[{speaker:'synthetic-user',text:'接口尚未联调。'}, {speaker:'Iris',role:'assistant',text:prior}];
          const orchestrator=createAnswerDraftOrchestrator({
            model:createOpenAICompatibleModelProvider({config,client}),
            requestContextRouter:createOpenAICompatibleRequestContextRouter({client}),
            planner:createOpenAICompatibleEvidencePlanner({client}),renderer:createOpenAICompatibleGroundedAnswerRenderer({client}),
            contextBuilder:{buildContext:async()=>({promptContext:sourceMessages.map(x=>x.text).join('\n'),liveChatMessages:sourceMessages,
              allowedFragments:[],deniedDocumentIds:[],retrievedFragmentCount:0,usedGroupMemories:[]})},
          });
          const responder=createFeishuMentionAnswerResponder({botOpenId:'ou_smokebot',answerDraftOrchestrator:orchestrator,
            canReplyWhenMentioned:runtime.canReplyWhenMentioned.bind(runtime),
            replier:{replyText:async()=>{throw Error('unexpected direct send');}},
            answerReplyDeliveryService:{respond:async input=>{const answer=await input.prepareAnswer();answers.push(answer.renderedText);return {replyMessageId:'synthetic-reply'};}},
          });
          const input=(id,question,chatId='qa-smoke-group')=>({messageId:id,chatId,senderId:'ou_smokeuser',text:'@_user_1 '+question,
            mentions:[{key:'@_user_1',openId:'ou_smokebot'}]});
          assert.deepEqual(await responder.maybeRespond(input('outside','我没听懂','outside-group')),{status:'skipped',reason:'runtime_disabled'});
          assert.equal(outbound.length,0);
          if(!permit) {
            await assert.rejects(responder.maybeRespond(input('denied','我没听懂')));
            assert.equal(outbound.length,1);assert.equal(sent.length,0);assert.equal(answers.length,0);
            checks.push({case:'qa-without-permit-zero-upstream-and-zero-delivery',passed:true});
          } else {
            // One structured PD-shaped request consumes the SAME gate before QA.
            assert.equal(await client.complete([{role:'system',content:'Synthetic JSON wiring check.'}],{responseFormat:{type:'json_schema',json_schema:{name:'smoke',strict:true,schema:{type:'object'}}}}),'{"smoke":true}');
            assert.equal((await responder.maybeRespond(input('followup','我没听懂'))).status,'replied');
            assert.equal(answers[0],explanation);
            assert.equal((await responder.maybeRespond(input('facts','接口当前状态是什么？'))).status,'replied');
            assert.equal(answers[1],'接口尚未联调。');
            assert.equal(sent.length,7);assert.equal(outbound.length,7);assert.equal(completions.length,0);
            assert.deepEqual(permits,['json_object','json_object','json_object','text','json_object','json_object','json_object']);
            const directWire=JSON.parse(sent[3]);assert.equal(directWire.response_format,undefined);
            assert.ok(directWire.messages.some(m=>m.content.includes(prior)),'prior assistant explanation context retained');
            runtime.setCapability('replyWhenMentioned',false);
            assert.deepEqual(await responder.maybeRespond(input('closed','我没听懂')),{status:'skipped',reason:'runtime_disabled'});
            assert.equal(outbound.length,7);assert.equal(answers.length,2);
            checks.push({case:'compiled-mention-router-planner-text-and-grounded-answer-through-one-gate',passed:true,loopbackHttp:7,fakeDeliveries:2});
          }
        } finally {monitoring=false;await observedMonitor;if(monitorError) throw monitorError;allowed.delete(endpoint);}
      } finally {monitoring=false;await gate.close();}
    }
    console.log(JSON.stringify({kind:'compiled-qa-joint-free-gate-wiring',checks,providerHttp:0,feishuMessages:0,
      readsProductionConfig:false,semanticAcceptance:false,realFeishuAcceptance:false}));
  } finally {
    globalThis.fetch=realFetch;
    const target=resolve(parent),root=resolve(tmpdir());assert.ok(target.startsWith(root+sep)&&basename(target).startsWith('iris-qa-wiring-'));
    await rm(target,{recursive:true,force:true});
  }
}
main().catch(error=>{console.error(error);process.exitCode=1;});
