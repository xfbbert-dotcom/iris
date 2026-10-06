import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, stat, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve, sep } from 'node:path';
import { createFreeGate } from './proactive-discussion-free-gate.mjs';

const secret = 'test-only-secret-never-log';
const wire = JSON.stringify({model:'qwen3.8-max',messages:[{role:'user',content:'private-wire-marker'}],response_format:{type:'json_object'},max_tokens:4096,enable_thinking:false,stream:false});
const validUpstream = () => new Response(JSON.stringify({model:'qwen3.8-max',choices:[{finish_reason:'stop',message:{role:'assistant',content:'{"ok":true}'}}],usage:{total_tokens:123}}),{status:200,headers:{'content-type':'application/json'}});

async function setup(options={}) {
  const parent = await mkdtemp(join(tmpdir(),'iris-gate-test-'));
  const calls=[];
  const gate=createFreeGate({sessionParent:parent,apiKey:secret,upstreamUrl:'https://example.invalid/v1/chat/completions',fetchImpl:async (url,init)=>{calls.push({url,init});return validUpstream();},...options});
  await gate.start();
  const url=`http://127.0.0.1:${gate.server.address().port}/v1/chat/completions`;
  return {gate,parent,calls,url,async cleanup(){
    await gate.close();
    const target=resolve(parent),root=resolve(tmpdir());
    assert.ok(target.startsWith(root+sep) && basename(target).startsWith('iris-gate-test-'));
    await rm(target,{recursive:true,force:true});
  }};
}
async function pending(gate,afterId) {
  for(let i=0;i<200;i++) {
    const files=await readdir(gate.sessionDir);
    const prior=afterId?Number(afterId.split('-').at(-1)):0;
    const name=files.find(x=>x.startsWith('pending-') && Number(x.slice(8,-5).split('-').at(-1))>prior);
    if(name) return JSON.parse(await readFile(join(gate.sessionDir,name),'utf8'));
    await new Promise(r=>setTimeout(r,10));
  }
  throw Error('pending not created');
}
async function permit(gate,p,overrides={}) {
  await writeFile(join(gate.sessionDir,`permit-${p.requestId}.json`),JSON.stringify({requestId:p.requestId,requestHash:p.requestHash,model:'qwen3.8-max',remainingTokens:200000,observedAt:new Date().toISOString(),expiresAt:new Date(Date.now()+30000).toISOString(),freeExhaustionStop:true,...overrides}),{flag:'wx'});
}
function request(url,body=wire) {return fetch(url,{method:'POST',headers:{authorization:`Bearer ${secret}`,'content-type':'application/json'},body});}
function deferred() {let resolve;const promise=new Promise(r=>{resolve=r;});return {promise,resolve};}

test('missing permit never sends and expires the window',async t=>{
  const x=await setup({permitWaitMs:90});t.after(x.cleanup);
  const result=await request(x.url);
  assert.equal(result.status,422);
  assert.equal(x.calls.length,0);
  assert.ok((await readdir(x.gate.sessionDir)).includes('stopped.json'));
});

test('fresh bound permit forwards identical wire once without sensitive records',async t=>{
  const x=await setup();t.after(x.cleanup);
  const reply=request(x.url);const p=await pending(x.gate);
  await permit(x.gate,p);
  assert.equal((await reply).status,200);
  assert.equal(x.calls.length,1);
  assert.deepEqual(x.calls[0].init.body,Buffer.from(wire));
  assert.equal(x.calls[0].url,'https://example.invalid/v1/chat/completions');
  const files=await readdir(x.gate.sessionDir);
  const contents=(await Promise.all(files.map(f=>readFile(join(x.gate.sessionDir,f),'utf8')))).join('\n');
  assert.ok(!contents.includes(secret));assert.ok(!contents.includes('private-wire-marker'));
  assert.ok(!contents.includes('{"ok":true}'));
});

test('the same wire needs a new request-specific permit',async t=>{
  const x=await setup();t.after(x.cleanup);
  const first=request(x.url);const p1=await pending(x.gate);await permit(x.gate,p1);assert.equal((await first).status,200);
  const second=request(x.url);const p2=await pending(x.gate,p1.requestId);
  assert.notEqual(p2.requestId,p1.requestId);assert.equal(p2.requestHash,p1.requestHash);
  await permit(x.gate,p2);assert.equal((await second).status,200);
  assert.equal(x.calls.length,2);
});

test('a later request cannot reuse the previous quota observation',async t=>{
  const x=await setup();t.after(x.cleanup);
  const first=request(x.url);const p1=await pending(x.gate);await permit(x.gate,p1);assert.equal((await first).status,200);
  await new Promise(r=>setTimeout(r,20));
  const second=request(x.url);const p2=await pending(x.gate,p1.requestId);
  await permit(x.gate,p2,{observedAt:p1.at});
  assert.equal((await second).status,422);
  assert.equal(x.calls.length,1);
});

test('invalid fresh-quota statements stop with zero upstream sends',async t=>{
  const bad=[
    {remainingTokens:199999},
    {requestHash:'wrong'},
    {model:'another-model'},
    {freeExhaustionStop:false},
    {observedAt:new Date(Date.now()-61000).toISOString()},
    {observedAt:new Date(Date.now()+60000).toISOString()},
    {expiresAt:new Date(Date.now()-1000).toISOString()}
  ];
  for(const override of bad) {
    const x=await setup();t.after(x.cleanup);
    const reply=request(x.url);const p=await pending(x.gate);await permit(x.gate,p,override);
    assert.equal((await reply).status,422);
    assert.equal(x.calls.length,0);
  }
});

test('caller cancellation before permit prevents a late send',async t=>{
  const x=await setup();t.after(x.cleanup);
  const controller=new AbortController();
  const reply=fetch(x.url,{method:'POST',headers:{authorization:`Bearer ${secret}`},body:wire,signal:controller.signal}).catch(()=>undefined);
  const p=await pending(x.gate);
  controller.abort();await reply;
  await new Promise(r=>setTimeout(r,80));
  await permit(x.gate,p);await new Promise(r=>setTimeout(r,80));
  assert.equal(x.calls.length,0);
});

test('concurrent request is rejected while another waits for permit',async t=>{
  const x=await setup();t.after(x.cleanup);
  const first=request(x.url);const p=await pending(x.gate);
  assert.equal((await request(x.url)).status,409);
  await permit(x.gate,p);assert.equal((await first).status,200);
  assert.equal(x.calls.length,1);
});

test('operator stop cancels an in-flight upstream and blocks later requests',async t=>{
  let sawAbort=false;
  const x=await setup({fetchImpl:(_url,init)=>new Promise((_resolve,reject)=>{
    init.signal.addEventListener('abort',()=>{sawAbort=true;reject(Error('aborted'));},{once:true});
  })});t.after(x.cleanup);
  const reply=request(x.url);const p=await pending(x.gate);await permit(x.gate,p);
  for(let i=0;i<100 && !(await readdir(x.gate.sessionDir)).some(f=>f.startsWith('outcome-'));i++) await new Promise(r=>setTimeout(r,10));
  const started=Date.now();
  await writeFile(join(x.gate.sessionDir,'stop.json'),'{}',{flag:'wx'});
  assert.equal((await reply).status,422);
  assert.ok(Date.now()-started<2000,'stop must cancel before upstream timeout');
  assert.equal(sawAbort,true);
  assert.equal((await request(x.url)).status,422);
  assert.equal(JSON.parse(await readFile(join(x.gate.sessionDir,'stopped.json'),'utf8')).uncertain,true);
});

test('upstream failure or invalid completion stops subsequent requests',async t=>{
  const failures=[
    new Response('bad',{status:429}),
    new Response(JSON.stringify({model:'other',choices:[{finish_reason:'stop'}],usage:{total_tokens:1}}),{status:200}),
    new Response(JSON.stringify({model:'qwen3.8-max',choices:[{finish_reason:'length'}],usage:{total_tokens:1}}),{status:200}),
    new Response(JSON.stringify({model:'qwen3.8-max',choices:[{finish_reason:'stop'}]}),{status:200})
  ];
  for(const response of failures) {
    let sends=0;
    const x=await setup({fetchImpl:async()=>{sends++;return response;}});t.after(x.cleanup);
    const first=request(x.url);const p=await pending(x.gate);await permit(x.gate,p);
    assert.equal((await first).status,422);
    assert.equal((await request(x.url)).status,422);
    assert.equal(sends,1);
  }
});

test('eight actual sends and reported token threshold bound later sends',async t=>{
  const x=await setup();t.after(x.cleanup);
  let prior;
  for(let i=0;i<8;i++) {
    const reply=request(x.url);const p=await pending(x.gate,prior);prior=p.requestId;
    await permit(x.gate,p);assert.equal((await reply).status,200);
  }
  assert.equal((await request(x.url)).status,422);
  assert.equal(x.calls.length,8);
  const y=await setup({fetchImpl:async()=>new Response(JSON.stringify({model:'qwen3.8-max',choices:[{finish_reason:'stop',message:{role:'assistant',content:'{}'}}],usage:{total_tokens:60001}}),{status:200})});t.after(y.cleanup);
  const first=request(y.url);const p=await pending(y.gate);await permit(y.gate,p);
  assert.equal((await first).status,200);
  assert.equal((await request(y.url)).status,422);
});

test('expired window and reused session directory refuse sends',async t=>{
  const x=await setup({windowMs:70});t.after(x.cleanup);
  await new Promise(r=>setTimeout(r,90));
  assert.equal((await request(x.url)).status,422);
  assert.equal(x.calls.length,0);
  const restarted=createFreeGate({sessionParent:x.parent,sessionDir:x.gate.sessionDir,apiKey:secret,upstreamUrl:'https://example.invalid/v1/chat/completions',fetchImpl:async()=>validUpstream()});
  await assert.rejects(restarted.start(),{code:'EEXIST'});
});

test('local route, bearer, wire contract and upstream endpoint reject unsafe requests',async t=>{
  const x=await setup();t.after(x.cleanup);
  assert.equal((await fetch(x.url,{method:'POST',body:wire})).status,401);
  assert.equal((await fetch(x.url.replace('/v1/chat/completions','/other'),{method:'POST',headers:{authorization:`Bearer ${secret}`},body:wire})).status,404);
  assert.equal((await request(x.url,JSON.stringify({...JSON.parse(wire),model:'other'}))).status,422);
  assert.equal(x.calls.length,0);
  for(const unsafe of ['http://example.invalid/v1/chat/completions','https://u:p@example.invalid/v1/chat/completions','https://example.invalid/v1/chat/completions?x=1'])
    assert.throws(()=>createFreeGate({sessionParent:x.parent,apiKey:secret,upstreamUrl:unsafe}),/invalid upstream endpoint/);
});

test('simultaneously arriving requests create only one pending request',async t=>{
  const x=await setup({permitWaitMs:90});t.after(x.cleanup);
  const results=await Promise.all([request(x.url),request(x.url)]);
  assert.deepEqual(results.map(r=>r.status).sort(),[409,422]);
  const files=await readdir(x.gate.sessionDir);
  assert.equal(files.filter(f=>f.startsWith('pending-')).length,1);
  assert.equal(x.calls.length,0);
});

test('caller disconnect during upstream cancels in-flight work and marks uncertainty',async t=>{
  let sawAbort=false;
  const x=await setup({fetchImpl:(_url,init)=>new Promise((_resolve,reject)=>{
    init.signal.addEventListener('abort',()=>{sawAbort=true;reject(Error('aborted'));},{once:true});
  })});t.after(x.cleanup);
  const controller=new AbortController();
  const reply=fetch(x.url,{method:'POST',headers:{authorization:`Bearer ${secret}`},body:wire,signal:controller.signal}).catch(()=>undefined);
  const p=await pending(x.gate);await permit(x.gate,p);
  for(let i=0;i<100 && !(await readdir(x.gate.sessionDir)).some(f=>f.startsWith('outcome-'));i++) await new Promise(r=>setTimeout(r,10));
  controller.abort();await reply;
  for(let i=0;i<100 && !(await readdir(x.gate.sessionDir)).includes('stopped.json');i++) await new Promise(r=>setTimeout(r,10));
  assert.equal(sawAbort,true);
  assert.equal(JSON.parse(await readFile(join(x.gate.sessionDir,'stopped.json'),'utf8')).uncertain,true);
  assert.equal((await request(x.url)).status,422);
});

test('non-stream wire without explicit stream field and provider prefix are accepted',async t=>{
  const x=await setup({upstreamUrl:'https://example.invalid/compatible-mode/v1/chat/completions'});t.after(x.cleanup);
  const body=JSON.stringify(Object.fromEntries(Object.entries(JSON.parse(wire)).filter(([key])=>key!=='stream')));
  const reply=request(x.url,body);const p=await pending(x.gate);await permit(x.gate,p);
  assert.equal((await reply).status,200);
  assert.equal(x.calls[0].url,'https://example.invalid/compatible-mode/v1/chat/completions');
  assert.deepEqual(x.calls[0].init.body,Buffer.from(body));
});

test('permit read completing after its wait deadline cannot dispatch',async t=>{
  const x=await setup({permitWaitMs:35,readFileImpl:async(path,...args)=>{
    if(basename(path).startsWith('permit-')) await new Promise(r=>setTimeout(r,60));
    return readFile(path,...args);
  }});t.after(x.cleanup);
  const reply=request(x.url);const p=await pending(x.gate);await permit(x.gate,p);
  assert.equal((await reply).status,422);
  assert.equal(x.calls.length,0);
});

test('stop or caller abort during outcome persistence prevents dispatch',async t=>{
  for(const action of ['stop','abort']) {
    const entered=deferred(),release=deferred();
    const x=await setup({writeFileImpl:async(path,...args)=>{
      if(basename(path).startsWith('outcome-')) {entered.resolve();await release.promise;}
      return writeFile(path,...args);
    }});t.after(x.cleanup);
    const controller=new AbortController();
    const reply=fetch(x.url,{method:'POST',headers:{authorization:`Bearer ${secret}`},body:wire,signal:controller.signal}).catch(()=>undefined);
    const p=await pending(x.gate);await permit(x.gate,p);await entered.promise;
    if(action==='stop') await writeFile(join(x.gate.sessionDir,'stop.json'),'{}',{flag:'wx'});
    else controller.abort();
    release.resolve();
    const result=await reply;
    if(action==='stop') assert.equal(result.status,422);
    assert.equal(x.calls.length,0);
  }
});

test('missing answer content stops the window after one upstream send',async t=>{
  let sends=0;
  const x=await setup({fetchImpl:async()=>{sends++;return new Response(JSON.stringify({model:'qwen3.8-max',choices:[{finish_reason:'stop',message:{role:'assistant'}}],usage:{total_tokens:10}}),{status:200});}});t.after(x.cleanup);
  const first=request(x.url);const p=await pending(x.gate);await permit(x.gate,p);
  assert.equal((await first).status,422);
  assert.equal((await request(x.url)).status,422);
  assert.equal(sends,1);
});

test('stop during final metadata write suppresses delivery and records uncertainty',async t=>{
  const entered=deferred(),release=deferred();let sends=0;
  const x=await setup({
    fetchImpl:async()=>{sends++;return validUpstream();},
    writeFileImpl:async(path,...args)=>{
      if(basename(path).startsWith('final-')) {entered.resolve();await release.promise;}
      return writeFile(path,...args);
    }
  });t.after(x.cleanup);
  const reply=request(x.url);const p=await pending(x.gate);await permit(x.gate,p);await entered.promise;
  await writeFile(join(x.gate.sessionDir,'stop.json'),'{}',{flag:'wx'});
  await new Promise(r=>setTimeout(r,50));
  release.resolve();
  assert.equal((await reply).status,422);
  assert.equal(sends,1);
  const files=await readdir(x.gate.sessionDir);
  assert.ok(files.some(f=>f.startsWith('uncertain-')));
  assert.equal(JSON.parse(await readFile(join(x.gate.sessionDir,'stopped.json'),'utf8')).uncertain,true);
});

test('disconnect during first stop check creates no pending request or upstream send',async t=>{
  const entered=deferred(),release=deferred();let first=true;
  const x=await setup({permitWaitMs:80,statImpl:async(path)=>{
    if(first && basename(path)==='stop.json') {first=false;entered.resolve();await release.promise;}
    return stat(path);
  }});t.after(x.cleanup);
  const controller=new AbortController();
  const reply=fetch(x.url,{method:'POST',headers:{authorization:`Bearer ${secret}`},body:wire,signal:controller.signal}).catch(()=>undefined);
  await entered.promise;
  controller.abort();await reply;
  await new Promise(r=>setTimeout(r,50)); // let the server's close event fire while blocked
  release.resolve();
  await new Promise(r=>setTimeout(r,130));
  assert.equal((await readdir(x.gate.sessionDir)).filter(f=>f.startsWith('pending-')).length,0);
  assert.equal(x.calls.length,0);
  assert.equal(JSON.parse(await readFile(join(x.gate.sessionDir,'stopped.json'),'utf8')).reason,'aborted-or-disconnected');
});
