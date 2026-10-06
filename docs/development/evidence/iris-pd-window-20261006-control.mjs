// Operator-only container probe/control. Full output is private; never print it to chat.
import pg from 'pg';
const CHAT='oc_637a9aca45f01943477f4e17f1fc5b9a';
const call=async(path,method='GET',body)=>{
  const r=await fetch('http://127.0.0.1:3000'+path,{method,
    headers:{authorization:'Bearer '+process.env.IRIS_INTERNAL_API_TOKEN,'content-type':'application/json'},
    body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(10000)});
  if(!r.ok) throw Error('control_http_'+r.status);
  const v=await r.json();
  if(method!=='GET' && path.includes('/runtime-control/') && (v.ok!==true||v.durable!==true)) throw Error('control_not_durable');
  return v;
};
const db=new pg.Client({connectionString:process.env.DATABASE_URL,connectionTimeoutMillis:5000});
try {
  const action=process.env.PD_WINDOW_ACTION??'snapshot';
  if(action==='caps-off') await call('/internal/runtime-control/capabilities','PATCH',{replyWhenMentioned:false,generateKnowledgeDrafts:false});
  else if(action==='global-off') await call('/internal/runtime-control/global','POST',{enabled:false});
  else if(action==='speech-off') await call('/internal/runtime-control/capabilities','PATCH',{proactiveSpeech:false});
  else if(action==='caps-restore') {
    const desired=JSON.parse(process.env.PD_WINDOW_CAPS);
    const current=await call('/internal/runtime-control/status');
    if(current.globalEnabled||current.desiredGlobalEnabled) throw Error('restore_requires_off');
    const patch={};
    for(const k of ['replyWhenMentioned','generateKnowledgeDrafts','proactiveSpeech']) {
      if(current.capabilities[k]!==false) throw Error('capability_concurrent_change');
      if(typeof desired[k]!=='boolean') throw Error('bad_restore');
      patch[k]=desired[k];
    }
    await call('/internal/runtime-control/capabilities','PATCH',patch);
  }
  else if(action==='global-on') {
    const current=await call('/internal/runtime-control/status');
    if(current.globalEnabled||current.desiredGlobalEnabled||current.capabilities.replyWhenMentioned||current.capabilities.generateKnowledgeDrafts||current.disabledGroupIds.includes(CHAT)||!current.capabilities.readGroupContext) throw Error('activation_precondition');
    await call('/internal/runtime-control/capabilities','PATCH',{proactiveSpeech:true});
    await call('/internal/runtime-control/global','POST',{enabled:true});
  }
  else if(!['snapshot','policy-on','policy-off'].includes(action)) throw Error('unknown_action');
  await db.connect();
  if(action.startsWith('policy-')) {
    const row=(await db.query('SELECT version,enabled FROM proactive_discussion_policies WHERE chat_id=$1',[CHAT])).rows[0];
    if(action==='policy-on' && row?.enabled) throw Error('policy_already_on');
    if(action==='policy-on'||row?.enabled) await call('/internal/proactive-discussion/policy','PUT',{chatId:CHAT,expectedVersion:Number(row?.version??0),enabled:action==='policy-on'});
  }
  await db.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
  await db.query("SET LOCAL statement_timeout='10s'");
  const counts={};
  for(const t of ['proactive_discussion_policies','proactive_discussion_groups','proactive_discussion_jobs','proactive_discussion_evaluations','proactive_discussion_issues','proactive_discussion_deliveries','proactive_discussion_sources','proactive_discussion_events']) counts[t]=(await db.query('SELECT count(*)::int AS n FROM '+t)).rows[0].n;
  const policy=(await db.query('SELECT version,enabled FROM proactive_discussion_policies WHERE chat_id=$1',[CHAT])).rows[0]??null;
  const jobs=(await db.query('SELECT state,count(*)::int AS n FROM proactive_discussion_jobs GROUP BY state')).rows;
  const deliveries=(await db.query('SELECT state,count(*)::int AS n FROM proactive_discussion_deliveries GROUP BY state')).rows;
  await db.query('ROLLBACK');
  console.log(JSON.stringify({at:new Date().toISOString(),action,control:await call('/internal/runtime-control/status'),status:await call('/internal/status'),pd:await call('/internal/proactive-discussion/status'),counts,policy,jobs,deliveries}));
} catch {console.error('pilot_control_failed');process.exitCode=1;}
finally {await db.end();}
