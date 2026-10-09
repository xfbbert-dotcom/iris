"""Bounded, manually supervised production window. No secret/body output; no automatic permits."""
# Stage the four reviewed files as ops.py/control.mjs/preflight.py/gate.mjs.
# Local preparation only does not establish production readiness or semantic acceptance.
import datetime,hashlib,json,os,re,subprocess,sys,time
from pathlib import Path
ROOT=Path('/opt/iris/repository'); STAGE=ROOT/'evidence/qa-pd-supervised-20261009'
TMP='/tmp/qa-pd-supervised-20261009'; CORE='iris-pilot-core-1'
CHAT='oc_637a9aca45f01943477f4e17f1fc5b9a'
OFF_ENV=['IRIS_MEMORY_EXTRACTION_ENABLED','IRIS_KNOWLEDGE_CARD_ENABLED','IRIS_KNOWLEDGE_CONFLICT_ENABLED','IRIS_MANAGED_KNOWLEDGE_UPDATE_ENABLED','IRIS_FEISHU_TASK_CREATION_ENABLED','IRIS_APPROVAL_ACTIONS_ENABLED','IRIS_ACTION_REVIEW_ENABLED','IRIS_PROACTIVE_SIGNAL_PLANNER_ENABLED','IRIS_PROACTIVE_SIGNAL_DELIVERY_ENABLED','IRIS_WIKI_SPACE_SYNC_ENABLED']
os.umask(0o077)
def run(args,input=None,timeout=50):
    p=subprocess.run(args,cwd=ROOT,input=input,capture_output=True,text=True,timeout=timeout)
    if p.returncode: raise RuntimeError('window command failed: '+args[0])
    return p.stdout
def write(name,value):
    with (STAGE/name).open('x') as f:json.dump(value,f)
def read(name):return json.loads((STAGE/name).read_text())
def node(source,env=None):
    args=['docker','exec','-i']
    for k,v in (env or {}).items():args+=['-e',k+'='+v]
    return run(args+[CORE,'node','--input-type=module'],source)
def control(action):
    env={'QA_PD_WINDOW_ACTION':action}
    if (STAGE/'before-control.json').exists():env['QA_PD_WINDOW_FROM']=read('before-control.json')['at']
    if action=='caps-restore':env['QA_PD_WINDOW_CAPS']=json.dumps(read('before-control.json')['control']['capabilities'])
    result=json.loads(node((STAGE/'control.mjs').read_text(),env))
    write('control-'+action+'-'+str(time.time_ns())+'.json',result)
    return result
def compose(args):
    return run(['docker','compose','--project-directory',str(ROOT/'deploy/pilot'),'--env-file',str(ROOT/'.env.pilot'),'-f',str(ROOT/'deploy/pilot/docker-compose.yml')]+args,timeout=120)
def env_lines(text):
    result={}
    for line in text.splitlines():
        m=re.match(r'^([A-Z][A-Z0-9_]*)=(.*)$',line)
        if m:
            if m[1] in result:raise RuntimeError('duplicate env field')
            result[m[1]]=line
    return result
def atomic_env(text):
    temp=ROOT/'.env.pilot.qa-pd-window-tmp'
    with temp.open('xb') as f:f.write(text.encode('utf8') if isinstance(text,str) else text)
    os.replace(temp,ROOT/'.env.pilot')
def healthy():
    until=time.monotonic()+90
    while time.monotonic()<until:
        c=json.loads(run(['docker','inspect',CORE]))[0]
        if c['State'].get('Health',{}).get('Status')=='healthy':return
        time.sleep(2)
    raise RuntimeError('Core readiness timeout')
def unchanged_services():
    for s,b in read('before-services.json').items():
        if s=='core':continue
        c=json.loads(run(['docker','inspect','iris-pilot-'+s+'-1']))[0]
        assert c['Id']==b['id'] and c['Image']==b['image'],'non-Core changed'
def gate_meta():return json.loads(run(['docker','exec',CORE,'cat',TMP+'/gate.json']))
def stop_gate():
    # A local rejected request makes the idle gate observe stop.json. No provider request.
    return json.loads(node("""import {readFile,writeFile} from 'node:fs/promises';
const p='/tmp/qa-pd-supervised-20261009';
try {const g=JSON.parse(await readFile(p+'/gate.json','utf8'));
await writeFile(g.sessionDir+'/stop.json','{}',{flag:'wx',mode:0o600}).catch(e=>{if(e.code!=='EEXIST')throw e;});
await fetch('http://127.0.0.1:8765/v1/chat/completions',{method:'POST',headers:{authorization:'Bearer '+process.env.IRIS_PROACTIVE_DISCUSSION_MODEL_API_KEY},body:'{}',signal:AbortSignal.timeout(2000)}).catch(()=>{});
let ack;for(let i=0;i<40;i++){try{ack=JSON.parse(await readFile(g.sessionDir+'/stopped.json','utf8'));break;}catch{await new Promise(r=>setTimeout(r,50));}}
console.log(JSON.stringify({ack:ack??null}));}catch{console.log(JSON.stringify({absent:true}));}"""))
def shutdown():
    # Host lock prevents manual stop and watchdog from restoring concurrently.
    import fcntl
    with (STAGE/'shutdown.lock').open('a') as lock:
        fcntl.flock(lock,fcntl.LOCK_EX)
        if (STAGE/'restored.json').exists():return read('restored.json')
        try:stopped=stop_gate()
        except Exception:
            control('global-off')
            stopped={'probeFailed':True}
        if (STAGE/'started.json').exists() and not stopped.get('ack'):
            # Missing acknowledgement is not proof of cancellation. Disable broadly first.
            control('global-off')
        # Persist the broad disable even if another narrower API fails.
        errors=[]
        for action in ['global-off','reply-off','speech-off','policy-off']:
            try:control(action)
            except Exception:errors.append(action)
        off=control('snapshot')['control']
        assert off['globalEnabled'] is False and off['desiredGlobalEnabled'] is False and off['persistence']['ok']
        assert off['capabilities']['replyWhenMentioned'] is False and off['capabilities']['proactiveSpeech'] is False
        # Keep unknown/sending records intact. Archive private gate evidence before Core recreation.
        exists=run(['docker','exec',CORE,'node','-e',"console.log(require('fs').existsSync('"+TMP+"'))"]).strip()=='true'
        if exists and not (STAGE/'container-final').exists():run(['docker','cp',CORE+':'+TMP,str(STAGE/'container-final')])
        assert not errors,'some stop controls failed'
        if not (STAGE/'caps-restored.json').exists():
            control('caps-restore');write('caps-restored.json',{'at':time.time()})
        current=(ROOT/'.env.pilot').read_text(); before=(STAGE/'before.env').read_text()
        updates=read('updates.json'); lines=env_lines(current); old=env_lines(before)
        if not (STAGE/'env-restored.json').exists():
            assert all(lines.get(k)==k+'='+v for k,v in updates.items()),'concurrent change to pilot env'
            assert (ROOT/'.env.pilot').read_bytes()==(STAGE/'candidate.env').read_bytes(),'concurrent env change requires manual recovery'
            atomic_env((STAGE/'before.env').read_bytes());write('env-restored.json',{'at':time.time()})
        else:assert all(lines.get(k)==old.get(k) for k in updates),'concurrent change after env restoration'
        compose(['up','-d','--no-deps','--no-build','--pull','never','core']);healthy()
        final=control('snapshot');unchanged_services()
        assert not final['control']['globalEnabled'] and not final['control']['desiredGlobalEnabled']
        assert final['control']['capabilities']==read('before-control.json')['control']['capabilities']
        assert not final['control']['capabilities']['replyWhenMentioned'] and not final['control']['capabilities']['proactiveSpeech']
        assert not final['policy'] or final['policy']['enabled'] is False
        live=json.loads(run(['docker','inspect',CORE]))[0]
        assert live['Image']==read('before-services.json')['core']['image'],'Core image changed during window'
        e=dict(x.split('=',1) for x in live['Config']['Env'])
        assert e['IRIS_PROACTIVE_DISCUSSION_ENABLED']=='false'
        assert e.get('IRIS_PROACTIVE_DISCUSSION_MODEL_API_KEY','')==read('before-live-env.json').get('IRIS_PROACTIVE_DISCUSSION_MODEL_API_KEY','')
        baseline_env=read('before-live-env.json')
        for k in updates:assert e.get(k)==baseline_env.get(k),'restored actual env mismatch'
        assert (ROOT/'.env.pilot').read_bytes()==(STAGE/'before.env').read_bytes(),'env bytes not restored'
        assert (ROOT/'deploy/pilot/docker-compose.yml').read_bytes()==(STAGE/'before.compose.yml').read_bytes(),'compose changed'
        needs_review=any(final['qa'].values()) or any(r['n'] and r['state'] in ['prepared','sending','outcome_unknown'] for r in final['deliveries'])
        result={'at':final['at'],'restored':True,'global':False,'desired':False,'replyEnabled':False,'pdEnabled':False,'gateStop':stopped,'temporaryGateContainerReplaced':True,'counts':final['counts'],'jobs':final['jobs'],'deliveries':final['deliveries'],'qaStates':final['qaStates'],'qaReconciliation':final['qa'],'requiresReconciliation':needs_review,'replayPerformed':False,'nonCoreUnchanged':True}
        write('restored.json',result);return result
action=sys.argv[1]
try:
    if action=='prepare':
        assert not (STAGE/'updates.json').exists()
        s=control('snapshot');c=s['control']
        assert not c['globalEnabled'] and not c['desiredGlobalEnabled'] and not c['capabilities']['proactiveSpeech'] and not c['capabilities']['replyWhenMentioned']
        assert not s['policy'] or not s['policy']['enabled']
        assert s['counts']==read('before-control.json')['counts']
        assert s['policy']==read('before-control.json')['policy']
        assert (ROOT/'.env.pilot').read_bytes()==(STAGE/'before.env').read_bytes()
        assert (ROOT/'deploy/pilot/docker-compose.yml').read_bytes()==(STAGE/'before.compose.yml').read_bytes()
        e=read('before-live-env.json')
        for k in ['IRIS_PROACTIVE_SIGNAL_PLANNER_ENABLED','IRIS_PROACTIVE_SIGNAL_DELIVERY_ENABLED','IRIS_MEMORY_EXTRACTION_ENABLED','IRIS_KNOWLEDGE_CONFLICT_ENABLED','IRIS_FEISHU_TASK_CREATION_ENABLED']:assert e.get(k,'false')=='false'
        assert e['IRIS_EMBEDDING_BASE_URL']=='http://embedding-model:11434/v1'
        assert all(c['capabilities'][k] is False for k in ['generateTaskDrafts','createFeishuTasks','writeKnowledgeBase','updateManagedKnowledge','callExternalTools'])
        assert c['capabilities']['readGroupContext'] and 'oc_637a9aca45f01943477f4e17f1fc5b9a' not in c['disabledGroupIds']
        # Credential arrives only on protected SSH stdin, never in argv or stdout.
        key=sys.stdin.read().strip().lstrip('\ufeff');assert re.fullmatch(r'[A-Za-z0-9_.-]{16,200}',key),'protected_key_format'
        model={'PROVIDER':'openai-compatible','BASE_URL':'http://127.0.0.1:8765/v1','API_KEY':key,'NAME':'qwen3.8-max','TIMEOUT_MS':'120000','STRUCTURED_OUTPUT_MODE':'json_object','MAX_TOKENS':'4096','ENABLE_THINKING':'false'}
        updates={'IRIS_RUNTIME_GLOBAL_ENABLED':'false','IRIS_ANSWER_ALLOWED_GROUP_IDS':CHAT,'IRIS_PROACTIVE_DISCUSSION_ENABLED':'true','IRIS_PROACTIVE_DISCUSSION_GROUP_IDS':CHAT,'IRIS_PROACTIVE_DISCUSSION_OPINION_MODE':'source-plan','IRIS_PROACTIVE_DISCUSSION_MODEL_SOURCE':'dedicated','IRIS_PROACTIVE_DISCUSSION_BATCH_LIMIT':'1','IRIS_INTERNAL_API_AUDIT_ACTOR':'qa-pd-supervised-20261009'}
        updates.update({k:'false' for k in OFF_ENV})
        for prefix in ['IRIS_MODEL_','IRIS_PROACTIVE_DISCUSSION_MODEL_']:updates.update({prefix+k:v for k,v in model.items()})
        text=(ROOT/'.env.pilot').read_text();env_lines(text)
        for k,v in updates.items():
            pattern=r'^'+re.escape(k)+r'=.*$'
            text=re.sub(pattern,k+'='+v,text,flags=re.M) if re.search(pattern,text,re.M) else text.rstrip('\n')+'\n'+k+'='+v+'\n'
        write('updates.json',updates)
        with (STAGE/'candidate.env').open('x') as f:f.write(text)
        candidate=json.loads(run(['docker','compose','--project-directory',str(ROOT/'deploy/pilot'),'--env-file',str(STAGE/'candidate.env'),'-f',str(ROOT/'deploy/pilot/docker-compose.yml'),'config','--format','json']))
        target=candidate['services']['core']['environment']
        for k in updates:assert str(target.get(k,''))==updates[k], 'candidate config mismatch'
        for k,v in e.items():
            if k.startswith('IRIS_') and k not in updates and k in target:assert str(target[k])==v,'unrelated env changed'
        control('caps-off')
        write('caps-applied.json',{'at':time.time()})
        atomic_env(text)
        write('config-applied.json',{'at':time.time()})
        compose(['up','-d','--no-deps','--no-build','--pull','never','core']);healthy()
        state=control('snapshot');assert not state['control']['globalEnabled'] and not state['control']['desiredGlobalEnabled']
        live=json.loads(run(['docker','inspect',CORE]))[0]
        actual=dict(x.split('=',1) for x in live['Config']['Env'])
        assert all(actual.get(k)==v for k,v in updates.items()),'actual config mismatch'
        assert not state['control']['capabilities']['replyWhenMentioned'] and not state['control']['capabilities']['generateKnowledgeDrafts']
        run(['docker','exec',CORE,'mkdir','-m','700',TMP])
        for name in ['proactive-discussion-free-gate.mjs','qa-free-gate-wiring-smoke.mjs']:
            assert (STAGE/name).read_bytes()==(ROOT/'scripts/pilot'/name).read_bytes(),'staged candidate script mismatch'
        for name in ['proactive-discussion-free-gate.mjs','qa-free-gate-wiring-smoke.mjs','gate.mjs']:
            run(['docker','cp',str(STAGE/name),CORE+':'+TMP+'/'+name])
            run(['docker','exec','-u','0',CORE,'chown','1000:1000',TMP+'/'+name])
            run(['docker','exec','-u','0',CORE,'chmod','600',TMP+'/'+name])
        smoke=json.loads(run(['docker','exec',CORE,'node',TMP+'/qa-free-gate-wiring-smoke.mjs','--core-dist','/app/apps/core/dist']))
        assert smoke['kind']=='compiled-qa-joint-free-gate-wiring' and all(row['passed'] for row in smoke['checks'])
        assert smoke['providerHttp']==0 and smoke['feishuMessages']==0 and smoke['readsProductionConfig'] is False
        write('wiring-smoke.json',smoke);unchanged_services()
        print(json.dumps({'prepared':True,'global':False,'desired':False,'policy':state['policy'],'wiringSmoke':smoke}))
    elif action=='start':
        assert not (STAGE/'started.json').exists() and not (STAGE/'restored.json').exists()
        assert (STAGE/'wiring-smoke.json').exists()
        s=control('snapshot');c=s['control']
        assert not c['globalEnabled'] and not c['desiredGlobalEnabled'] and not c['capabilities']['replyWhenMentioned'] and not c['capabilities']['generateKnowledgeDrafts']
        # Non-secret endpoint stays in the protected process environment, not Core configuration.
        upstream=os.environ['IRIS_QA_PD_WINDOW_UPSTREAM']
        run(['docker','exec','-d','-e','IRIS_QA_PD_WINDOW_UPSTREAM='+upstream,CORE,'node',TMP+'/gate.mjs'])
        for _ in range(20):
            try:g=gate_meta();break
            except Exception:time.sleep(.1)
        else:raise RuntimeError('gate not listening')
        assert g['profile']=='pd-and-qa' and g['model']=='qwen3.8-max' and g['maxRequests']==8 and g['windowMs']==900000 and g['reportedTokenStop']==60000
        write('started.json',{'at':datetime.datetime.fromisoformat(g['startedAt'].replace('Z','+00:00')).timestamp(),'gate':g})
        with (STAGE/'watchdog.log').open('x') as log:
            watcher=subprocess.Popen(['python3',str(STAGE/'ops.py'),'watch'],stdin=subprocess.DEVNULL,stdout=log,stderr=log,start_new_session=True,cwd=ROOT)
        write('watchdog.json',{'pid':watcher.pid})
        control('global-on');s=control('policy-on')
        assert s['control']['globalEnabled'] and s['control']['desiredGlobalEnabled'] and s['policy']['enabled'] and s['control']['capabilities']['replyWhenMentioned']
        print(json.dumps({'active':True,'startedAt':g['startedAt'],'deadlineSeconds':900,'policyVersion':s['policy']['version']}))
    elif action=='watch':
        start=read('started.json')['at']
        try:
            while time.time()-start<890:
                status=json.loads(node("""import {readFile,access} from 'node:fs/promises';let stopped=false;const g=JSON.parse(await readFile('/tmp/qa-pd-supervised-20261009/gate.json','utf8'));try{process.kill(g.pid,0);}catch{stopped=true;}try{await access(g.sessionDir+'/stopped.json');stopped=true;}catch{}console.log(JSON.stringify({stopped}));"""))
                if status['stopped'] or (STAGE/'stop-requested.json').exists():break
                time.sleep(1)
        finally:
            # Keep retrying recovery after a transient control/DB error; never silently leave an active window.
            while True:
                try:print(json.dumps(shutdown()));break
                except Exception:
                    write('watchdog-recovery-failed-'+str(time.time_ns())+'.json',{'at':time.time(),'requiresRecovery':True})
                    try:control('global-off')
                    except Exception:pass
                    time.sleep(2)
    elif action=='stop':
        (STAGE/'stop-requested.json').touch(mode=0o600,exist_ok=True)
        print(json.dumps(shutdown()))
    elif action=='next':
        print(node("""import {readFile,readdir} from 'node:fs/promises';const g=JSON.parse(await readFile('/tmp/qa-pd-supervised-20261009/gate.json','utf8'));const end=Date.now()+45000;while(true){const f=await readdir(g.sessionDir);if(f.includes('stopped.json')){console.log(JSON.stringify({stop:JSON.parse(await readFile(g.sessionDir+'/stopped.json','utf8'))}));break;}const names=f.filter(x=>x.startsWith('pending-'));let found=false;for(const n of names){const p=JSON.parse(await readFile(g.sessionDir+'/'+n,'utf8'));if(!f.includes('permit-'+p.requestId+'.json')&&!f.includes('final-'+p.requestId+'.json')){console.log(JSON.stringify({pending:p}));found=true;break;}}if(found)break;if(Date.now()>end){console.log(JSON.stringify({idle:true}));break;}await new Promise(r=>setTimeout(r,100));}"""))
    elif action=='pending':
        print(node("""import {readFile,readdir} from 'node:fs/promises';const g=JSON.parse(await readFile('/tmp/qa-pd-supervised-20261009/gate.json','utf8'));const f=await readdir(g.sessionDir);let stop=null;try{stop=JSON.parse(await readFile(g.sessionDir+'/stopped.json','utf8'));}catch{}const pending=[];for(const n of f.filter(x=>x.startsWith('pending-'))){const p=JSON.parse(await readFile(g.sessionDir+'/'+n,'utf8'));if(!f.includes('permit-'+p.requestId+'.json')&&!f.includes('final-'+p.requestId+'.json'))pending.push(p);}console.log(JSON.stringify({pending,stop,finals:f.filter(x=>x.startsWith('final-')).length}));"""))
    elif action=='permit':
        permit=json.loads(sys.stdin.read())
        # Operator-supplied observation from the UI, never manufactured by this helper.
        source="""import {readFile,writeFile,link,unlink,access} from 'node:fs/promises';const g=JSON.parse(await readFile('/tmp/qa-pd-supervised-20261009/gate.json','utf8'));const p=JSON.parse(process.env.QA_PD_WINDOW_PERMIT);if(!/^[a-f0-9-]+-\\d+$/.test(p.requestId))throw Error('id');const original=JSON.parse(await readFile(g.sessionDir+'/pending-'+p.requestId+'.json','utf8'));if(g.profile!=='pd-and-qa'||original.profile!=='pd-and-qa'||p.profile!==original.profile||!['text','json_object'].includes(original.responseMode)||p.responseMode!==original.responseMode||original.requestHash!==p.requestHash||p.model!==original.model)throw Error('permit_binding');for(const n of ['stop.json','stopped.json','final-'+p.requestId+'.json']){let present=false;try{await access(g.sessionDir+'/'+n);present=true;}catch(e){if(e.code!=='ENOENT')throw e;}if(present)throw Error('request_closed');}const path=g.sessionDir+'/permit-'+p.requestId+'.json';await writeFile(path+'.tmp',JSON.stringify(p),{flag:'wx',mode:0o600});await link(path+'.tmp',path);await unlink(path+'.tmp');console.log(JSON.stringify({permitWritten:true,requestId:p.requestId,profile:p.profile,responseMode:p.responseMode}));"""
        print(node(source,{'QA_PD_WINDOW_PERMIT':json.dumps(permit)}))
    elif action=='status':
        s=control('snapshot');print(json.dumps({'at':s['at'],'control':{k:v for k,v in s['control'].items() if k in ['globalEnabled','desiredGlobalEnabled','revision','capabilities']},'policy':s['policy'],'counts':s['counts'],'jobs':s['jobs'],'deliveries':s['deliveries'],'qaStates':s['qaStates'],'qaReconciliation':s['qa'],'pd':s['pd']}))
    else:raise RuntimeError('unknown operation')
except Exception as error:
    # No repr(error) from subprocess/environment or provider output.
    import traceback
    print(json.dumps({'ok':False,'operation':action,'errorType':type(error).__name__,'line':traceback.extract_tb(error.__traceback__)[-1].lineno,'code':str(error) if isinstance(error,(AssertionError,RuntimeError)) else 'operation_failed'}),file=sys.stderr)
    if action in ['prepare','start','permit'] and (STAGE/'config-applied.json').exists():
        try:print(json.dumps(shutdown()))
        except Exception:print('window_recovery_requires_inspection',file=sys.stderr)
    elif action=='prepare' and (STAGE/'caps-applied.json').exists():
        try:control('global-off');control('caps-restore')
        except Exception:print('capability_recovery_requires_inspection',file=sys.stderr)
    sys.exit(1)
