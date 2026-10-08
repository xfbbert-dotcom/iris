// One manual timing drill. Only loopback HTTP; the upstream is an injected fake.
// Never pass a real key or business text. A browser quota observation permits only
// this synthetic request and must never be copied to a real session.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp,readFile,readdir,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createFreeGate,FREE_GATE_TIMING} from './proactive-discussion-free-gate.mjs';
assert.equal(process.argv.length,2);
const clientPath=resolve('apps/core/dist/model/openai-compatible-chat-completions-client.js');
const configPath=resolve('apps/core/dist/config/env.js');
const {createOpenAICompatibleChatCompletionsClient}=await import(pathToFileURL(clientPath).href);
const {readProactiveDiscussionModelProviderConfig}=await import(pathToFileURL(configPath).href);
const key='operator-calibration-placeholder';
const parent=await mkdtemp(join(tmpdir(),'iris-pd-operator-calibration-'));
let fakeUpstreamCalls=0,loopbackHttp=0,clientTimeoutMs;
const gate=createFreeGate({sessionParent:parent,apiKey:key,
  upstreamUrl:'https://operator-calibration.invalid/v1/chat/completions',
  fetchImpl:async()=>{fakeUpstreamCalls++;return new Response(JSON.stringify({model:'qwen3.8-max',
    choices:[{finish_reason:'stop',message:{content:'{"calibration":true}'}}],usage:{total_tokens:1}}),{status:200});}});
try {
  await gate.start();
  const baseUrl=`http://127.0.0.1:${gate.server.address().port}/v1`;
  // Explicit synthetic config only: never load process.env, a protected key or
  // production configuration. The real compiled client reaches loopback only.
  const config=readProactiveDiscussionModelProviderConfig({
    IRIS_PROACTIVE_DISCUSSION_MODEL_SOURCE:'dedicated',
    IRIS_PROACTIVE_DISCUSSION_MODEL_PROVIDER:'openai-compatible',
    IRIS_PROACTIVE_DISCUSSION_MODEL_BASE_URL:baseUrl,
    IRIS_PROACTIVE_DISCUSSION_MODEL_API_KEY:key,
    IRIS_PROACTIVE_DISCUSSION_MODEL_NAME:'qwen3.8-max',
    IRIS_PROACTIVE_DISCUSSION_MODEL_TIMEOUT_MS:String(FREE_GATE_TIMING.clientTimeoutMs),
    IRIS_PROACTIVE_DISCUSSION_MODEL_STRUCTURED_OUTPUT_MODE:'json_object',
    IRIS_PROACTIVE_DISCUSSION_MODEL_MAX_TOKENS:'4096',
    IRIS_PROACTIVE_DISCUSSION_MODEL_ENABLE_THINKING:'false',
  });
  const client=createOpenAICompatibleChatCompletionsClient({config,
    fetch:async(url,init)=>{
      assert.equal(url,`${baseUrl}/chat/completions`);
      loopbackHttp++;
      return fetch(url,{...init,redirect:'error'});
    },scheduleTimeout:(callback,ms)=>{clientTimeoutMs=ms;return setTimeout(callback,ms);}});
  const response=client.complete([{role:'user',content:'Local synthetic operator timing drill.'}],{
    responseFormat:{type:'json_schema',json_schema:{name:'Calibration',strict:true,schema:{
      type:'object',additionalProperties:false,properties:{calibration:{type:'boolean'}},required:['calibration']}}},
  }).then(content=>({status:200,content}),error=>({status:error.statusCode??0}));
  let pending;
  const pendingDeadline=Date.now()+3000;
  while(!pending&&Date.now()<pendingDeadline){
    const file=(await readdir(gate.sessionDir)).find(x=>x.startsWith('pending-'));
    if(file)pending=JSON.parse(await readFile(join(gate.sessionDir,file),'utf8'));
    else await new Promise(r=>setTimeout(r,10));
  }
  assert.ok(pending,'local client did not produce a pending request');
  console.log(JSON.stringify({syntheticOnly:true,sessionDir:gate.sessionDir,pending}));
  const result=await response;
  const finalPath=join(gate.sessionDir,`final-${pending.requestId}.json`);
  let final=null;try{final=JSON.parse(await readFile(finalPath,'utf8'));}catch{}
  let permit=null;try{permit=JSON.parse(await readFile(join(gate.sessionDir,`permit-${pending.requestId}.json`),'utf8'));}catch{}
  const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
  const report={kind:'manual-operator-timing-calibration',syntheticOnly:true,providerHttp:0,
    startedAt:pending.at,httpStatus:result.status,fakeUpstreamCalls,loopbackHttp,
    observedAt:permit?.observedAt??null,
    dispatchDelayMs:final?.sentAt?Date.parse(final.sentAt)-Date.parse(pending.at):null,
    timing:FREE_GATE_TIMING,clientTimeoutMs,
    passed:result.status===200&&result.content==='{"calibration":true}'&&fakeUpstreamCalls===1&&loopbackHttp===1,
    compiledClientSha256:sha(await readFile(clientPath)),compiledConfigSha256:sha(await readFile(configPath)),
    gateSha256:sha(await readFile(fileURLToPath(new URL('./proactive-discussion-free-gate.mjs',import.meta.url)))),
    semanticAcceptance:false,feishuAcceptance:false};
  await writeFile(join(parent,'report.json'),JSON.stringify(report,null,2),{flag:'wx'});
  console.log(JSON.stringify({reportPath:join(parent,'report.json'),...report}));
  if(!report.passed)process.exitCode=1;
} finally {await gate.close();}
