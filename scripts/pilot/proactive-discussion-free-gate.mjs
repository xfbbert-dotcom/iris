// Local, manually permitted pilot bridge. A permit is an operator's fresh
// assertion about free quota; this process has no quota-reading API.
import { createServer } from 'node:http';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const MODEL='qwen3.8-max';
const MAX_BODY=262144;
// Manual UI + tool round trips exceeded 20 seconds in the supervised pilot.
// Dedicated clients need room for both this wait and the upstream response.
// This changes neither permit freshness nor the overall pilot window.
export const FREE_GATE_TIMING=Object.freeze({permitWaitMs:60000,requestMs:30000,clientTimeoutMs:120000});
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const iso=ms=>new Date(ms).toISOString();

function endpoint(value) {
  const u=new URL(value);
  if(u.protocol!=='https:' || u.username || u.password || u.search || u.hash || !u.hostname || !u.pathname.endsWith('/v1/chat/completions')) throw Error('invalid upstream endpoint');
  return u.href;
}
function fail(res,status) {
  if(!res.destroyed && !res.writableEnded) {
    res.writeHead(status,{'content-type':'application/json','cache-control':'no-store'});
    res.end('{"error":"free pilot gate stopped or request rejected","retryable":false}');
  }
}
function validWire(bytes,profile) {
  let body;
  try {body=JSON.parse(bytes.toString('utf8'));} catch {return false;}
  if(!(body && !Array.isArray(body) && typeof body==='object' && body.model===MODEL &&
    body.max_tokens===4096 &&
    body.enable_thinking===false && (body.stream===false || body.stream===undefined) &&
    Array.isArray(body.messages) && body.messages.length>0 &&
    body.messages.every(m=>m && typeof m==='object' && !Array.isArray(m)))) return false;
  if(body.response_format?.type==='json_object') return 'json_object';
  if(profile==='pd-and-qa' && !Object.hasOwn(body,'response_format')) return 'text';
  return false;
}
function validPermit(p,pending,now) {
  if(!p || typeof p!=='object' || Array.isArray(p)) return false;
  const observed=Date.parse(p.observedAt), expires=Date.parse(p.expiresAt);
  const requested=Date.parse(pending.at);
  return p.requestId===pending.requestId && p.requestHash===pending.requestHash &&
    (pending.profile===undefined || (p.profile===pending.profile && p.responseMode===pending.responseMode)) &&
    p.model===MODEL && p.freeExhaustionStop===true &&
    Number.isFinite(p.remainingTokens) && p.remainingTokens>=200000 &&
    Number.isFinite(observed) && observed>=requested && observed<=now && now-observed<60000 &&
    Number.isFinite(expires) && expires>now;
}
async function responseBytes(response,signal) {
  if(!response.body) throw Error('missing body');
  const reader=response.body.getReader();let size=0;const chunks=[];
  try {
    while(true) {
      if(signal.aborted) throw Error('aborted');
      const part=await reader.read();if(part.done) break;
      size+=part.value.byteLength;
      if(size>MAX_BODY) throw Error('oversize');
      chunks.push(part.value);
    }
  } finally {reader.releaseLock();}
  return Buffer.concat(chunks);
}

export function createFreeGate(options={}) {
  const {sessionParent,sessionDir:chosenDir,apiKey,upstreamUrl,profile='pd',fetchImpl=fetch,now=Date.now,readFileImpl=readFile,writeFileImpl=writeFile,statImpl=stat}=options;
  if(profile!=='pd' && profile!=='pd-and-qa') throw Error('invalid gate profile');
  if(typeof apiKey!=='string' || !apiKey.trim()) throw Error('gate API key required');
  if(typeof sessionParent!=='string' || !sessionParent) throw Error('session parent required');
  const upstream=endpoint(upstreamUrl);
  const limits={maxRequests:8,windowMs:900000,tokenStop:60000,
    permitWaitMs:FREE_GATE_TIMING.permitWaitMs,requestMs:FREE_GATE_TIMING.requestMs};
  // Overrides exist for deterministic local tests; the CLI never passes them.
  for(const k of Object.keys(limits)) if(options[k]!==undefined) {
    if(!Number.isSafeInteger(options[k]) || options[k]<=0) throw Error('invalid local test limit');
    limits[k]=options[k];
  }
  const sessionId=randomUUID();
  const sessionDir=chosenDir??join(sessionParent,`pd-free-${sessionId}`);
  const state={startedAt:0,requests:0,reportedTokens:0,stopped:false,active:null,seq:0};
  let server;
  const write=(name,value)=>writeFileImpl(join(sessionDir,name),JSON.stringify(value)+'\n',{flag:'wx',mode:0o600});
  async function stop(reason,uncertain=false) {
    state.stopped=true;
    state.active?.controller.abort();
    try {await write('stopped.json',{reason,at:iso(now()),uncertain});} catch(e) {if(e.code!=='EEXIST') throw e;}
  }
  async function blocked(afterDispatch=false) {
    if(state.stopped) return true;
    try {await statImpl(join(sessionDir,'stop.json'));await stop('operator-stop',Boolean(state.active?.sent));return true;}
    catch(e) {if(e.code!=='ENOENT') throw e;}
    if(now()-state.startedAt>=limits.windowMs) {await stop('window-expired',Boolean(state.active?.sent));return true;}
    if(!afterDispatch && state.requests>=limits.maxRequests) {await stop('request-cap');return true;}
    if(!afterDispatch && state.reportedTokens>=limits.tokenStop) {await stop('reported-token-threshold');return true;}
    return false;
  }
  async function handler(req,res) {
    res.setHeader('cache-control','no-store');
    if(req.method!=='POST' || req.url!=='/v1/chat/completions') return fail(res,404);
    const supplied=req.headers.authorization;
    const expected=`Bearer ${apiKey}`;
    if(typeof supplied!=='string' || Buffer.byteLength(supplied)!==Buffer.byteLength(expected) ||
       !timingSafeEqual(Buffer.from(supplied),Buffer.from(expected))) return fail(res,401);
    if(state.active) return fail(res,409);
    const controller=new AbortController();
    const active={controller,sent:false};state.active=active;
    const disconnect=()=>controller.abort();
    req.on('aborted',disconnect);
    res.on('close',()=>{if(!res.writableEnded) disconnect();});
    let pending,record,stopPoll;
    try {
      if(await blocked()) return fail(res,422);
      if(controller.signal.aborted || req.aborted || res.destroyed) throw Error('caller disconnected');
      const chunks=[];let size=0;
      for await(const chunk of req) {
        size+=chunk.length;if(size>MAX_BODY) throw Error('body too large');chunks.push(chunk);
      }
      if(controller.signal.aborted) throw Error('caller disconnected');
      const bytes=Buffer.concat(chunks);
      const responseMode=validWire(bytes,profile);
      if(!responseMode) return fail(res,422);
      const scope=profile==='pd-and-qa'?{profile,responseMode}:{};
      pending={requestId:`${sessionId}-${++state.seq}`,requestHash:sha(bytes),model:MODEL,...scope,at:iso(now())};
      record={requestId:pending.requestId,requestHash:pending.requestHash,model:MODEL,...scope,startedAt:iso(now()),status:'pending'};
      await write(`pending-${pending.requestId}.json`,pending);
      const permitPath=join(sessionDir,`permit-${pending.requestId}.json`);
      const until=Math.min(state.startedAt+limits.windowMs,now()+limits.permitWaitMs);
      let permit;
      while(!controller.signal.aborted && now()<until) {
        if(await blocked()) throw Error('window stopped');
        try {permit=JSON.parse(await readFileImpl(permitPath,'utf8'));break;}
        catch(e) {if(e.code!=='ENOENT') throw Error('invalid permit');}
        await sleep(25);
      }
      if(controller.signal.aborted) throw Error('caller disconnected');
      if(now()>=until || !validPermit(permit,pending,now())) throw Error('permit invalid or timed out');
      if(await blocked()) throw Error('window stopped');
      record.status='dispatch-prepared';
      await write(`outcome-${pending.requestId}.json`,record);
      // No metadata await after this check and before the single fetch call.
      if(controller.signal.aborted || now()>=until) throw Error('dispatch cancelled');
      if(await blocked()) throw Error('window stopped');
      if(controller.signal.aborted || now()>=until || !validPermit(permit,pending,now())) throw Error('dispatch permit expired');
      const remaining=state.startedAt+limits.windowMs-now();
      if(remaining<=0) throw Error('window expired before dispatch');
      const timeout=Math.min(limits.requestMs,remaining);
      const timeoutId=setTimeout(()=>controller.abort(),timeout);
      stopPoll=setInterval(async()=>{
        if(state.stopped) return;
        try {await statImpl(join(sessionDir,'stop.json'));await stop('operator-stop',true);}
        catch(e) {if(e.code!=='ENOENT') controller.abort();}
      },25);
      state.requests++;active.sent=true;record.status='sent';record.sentAt=iso(now());
      let response,raw;
      try {
        response=await fetchImpl(upstream,{method:'POST',headers:{authorization:expected,'content-type':'application/json'},body:bytes,redirect:'error',signal:controller.signal});
        if(controller.signal.aborted) throw Error('aborted');
        raw=await responseBytes(response,controller.signal);
      } finally {clearTimeout(timeoutId);}
      record.httpStatus=response.status;
      record.responseSha256=sha(raw);
      if(!response.ok) throw Error('upstream status');
      let decoded;
      try {decoded=JSON.parse(raw.toString('utf8'));} catch {throw Error('invalid response');}
      const used=decoded?.usage?.total_tokens;
      if(decoded.model!==MODEL || !Array.isArray(decoded.choices) || decoded.choices.length!==1 ||
         decoded.choices[0]?.finish_reason!=='stop' ||
         typeof decoded.choices[0]?.message?.content!=='string' ||
         !Number.isSafeInteger(used) || used<=0) throw Error('invalid completion');
      state.reportedTokens+=used;record.reportedTokens=used;record.status='accepted';record.finishedAt=iso(now());
      await write(`final-${pending.requestId}.json`,record);
      if(controller.signal.aborted || await blocked(true) || controller.signal.aborted) throw Error('caller disconnected or stopped');
      res.writeHead(200,{'content-type':'application/json','cache-control':'no-store'});res.end(raw);
    } catch {
      if(active.sent) {
        const uncertain={...record,status:'uncertain',finishedAt:iso(now())};
        try {await write(`final-${pending.requestId}.json`,uncertain);}
        catch(e) {if(e.code==='EEXIST') await write(`uncertain-${pending.requestId}.json`,uncertain);else throw e;}
      }
      await stop(controller.signal.aborted?'aborted-or-disconnected':'permit-or-upstream-failure',active.sent);
      fail(res,422);
    } finally {
      clearInterval(stopPoll);
      req.off('aborted',disconnect);
      state.active=null;
    }
  }
  return {
    get sessionDir(){return sessionDir;},get server(){return server;},
    async start(port=0) {
      await mkdir(sessionDir,{mode:0o700});
      state.startedAt=now();
      server=createServer((req,res)=>{handler(req,res).catch(async()=>{await stop('internal-failure',Boolean(state.active?.sent));fail(res,422);});});
      await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',resolve);});
      return this;
    },
    async close(){if(state.active) state.active.controller.abort();if(server?.listening) await new Promise(resolve=>server.close(resolve));}
  };
}

if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href) {
  if(process.argv.length===3 && process.argv[2]==='--help') {
    console.log('Local free gate. Set IRIS_PD_FREE_GATE_API_KEY, IRIS_PD_FREE_GATE_SESSION_PARENT, IRIS_PD_FREE_GATE_UPSTREAM_URL, optionally IRIS_PD_FREE_GATE_PORT and IRIS_PD_FREE_GATE_PROFILE (pd by default, or pd-and-qa). Operator writes permit-<requestId>.json after fresh free-quota check; joint permits must match pending profile and responseMode. Write stop.json to stop. Both modes share eight sends, fifteen minutes and the reported-token threshold.');
  } else if(process.argv.length!==2) {
    console.error('unsupported arguments');process.exitCode=2;
  } else {
    try {
      const port=Number(process.env.IRIS_PD_FREE_GATE_PORT??8765);
      if(!Number.isSafeInteger(port)||port<1||port>65535) throw Error('invalid port');
      const gate=createFreeGate({sessionParent:process.env.IRIS_PD_FREE_GATE_SESSION_PARENT,apiKey:process.env.IRIS_PD_FREE_GATE_API_KEY,upstreamUrl:process.env.IRIS_PD_FREE_GATE_UPSTREAM_URL,profile:process.env.IRIS_PD_FREE_GATE_PROFILE});
      await gate.start(port);
      console.log(JSON.stringify({listening:'127.0.0.1',port,sessionDir:gate.sessionDir}));
    } catch {console.error('free gate startup rejected');process.exitCode=2;}
  }
}
