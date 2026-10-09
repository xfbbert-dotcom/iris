"""Read-only production inspection; save private baseline, emit only bounded metadata."""
import hashlib,json,os,subprocess
from pathlib import Path
ROOT=Path('/opt/iris/repository')
STAGE=ROOT/'evidence/qa-pd-supervised-20261009'
os.umask(0o077)
def run(args,input=None):
    p=subprocess.run(args,cwd=ROOT,input=input,capture_output=True,text=True,timeout=40)
    if p.returncode: raise RuntimeError('preflight command failed: '+args[0])
    return p.stdout
def save(name,data):
    with (STAGE/name).open('x') as f: json.dump(data,f)
assert STAGE.is_dir() and not (STAGE/'before.env').exists()
assert run(['git','rev-parse','HEAD']).strip()=='aff258f7fa0a1560cdbe51d305bf97bb88c5a0b5'
containers={s:json.loads(run(['docker','inspect','iris-pilot-'+s+'-1']))[0] for s in ['core','ai-worker','caddy','postgres','redis','embedding-model']}
core=containers['core']; env=dict(x.split('=',1) for x in core['Config']['Env'])
assert core['State']['Health']['Status']=='healthy'
assert core['Image']=='sha256:9be24803b0a63b12b29dd2fe158f0c7e3506b803ba013b25db7335fc24866f6c'
assert env.get('IRIS_PROACTIVE_DISCUSSION_ENABLED')=='false'
assert env.get('IRIS_RUNTIME_GLOBAL_ENABLED')=='false'
save('before-live-env.json',env)
save('before-services.json',{s:{'id':c['Id'],'image':c['Image']} for s,c in containers.items()})
for name,source in [('before.env','.env.pilot'),('before.compose.yml','deploy/pilot/docker-compose.yml')]:
    with (STAGE/name).open('xb') as f:f.write((ROOT/source).read_bytes())
snapshot=json.loads(run(['docker','exec','-i','iris-pilot-core-1','node','--input-type=module'],(STAGE/'control.mjs').read_text()))
save('before-control.json',snapshot)
c=snapshot['control']
assert not c['globalEnabled'] and not c['desiredGlobalEnabled'] and c['persistence']['ok']
assert not c['capabilities']['proactiveSpeech'] and not c['capabilities']['replyWhenMentioned']
assert not snapshot['policy'] or snapshot['policy']['enabled'] is False
# Historical sent/cancelled rows are expected. Preserve this exact nonzero baseline.
assert all(isinstance(n,int) and n>=0 for n in snapshot['counts'].values())
assert not any(r['n'] and r['state'] in ['pending','processing','retry'] for r in snapshot['jobs']), 'pending jobs require review'
assert not any(r['n'] and r['state'] in ['prepared','sending','outcome_unknown'] for r in snapshot['deliveries']), 'PD delivery requires reconciliation'
assert all(snapshot['qa'][k]==0 for k in ['unresolved','reconciliation_required','pending_safe_notice','uncertain_safe_notice']), 'QA receipts require reconciliation; never replay'
off=['IRIS_PROACTIVE_SIGNAL_PLANNER_ENABLED','IRIS_PROACTIVE_SIGNAL_DELIVERY_ENABLED','IRIS_MEMORY_EXTRACTION_ENABLED','IRIS_KNOWLEDGE_CONFLICT_ENABLED','IRIS_FEISHU_TASK_CREATION_ENABLED']
assert all(env.get(k,'false')=='false' for k in off)
assert env['IRIS_EMBEDDING_BASE_URL']=='http://embedding-model:11434/v1'
assert all(c['capabilities'][k] is False for k in ['generateTaskDrafts','createFeishuTasks','writeKnowledgeBase','updateManagedKnowledge','callExternalTools'])
assert c['capabilities']['readGroupContext'] and 'oc_637a9aca45f01943477f4e17f1fc5b9a' not in c['disabledGroupIds']
report={'at':snapshot['at'],'ok':True,'app':'aff258f7','coreHealthy':True,'global':False,'desired':False,'replyEnabled':False,'revision':c['revision'],'capabilities':c['capabilities'],'disabledGroups':len(c['disabledGroupIds']),'targetDisabled':False,'domainCounts':snapshot['counts'],'qaStates':snapshot['qaStates'],'qaReconciliation':snapshot['qa'],'offEntrypoints':{k:env.get(k,'false') for k in off},'embeddingLocal':True,'wikiInitiallyEnabled':env.get('IRIS_WIKI_SPACE_SYNC_ENABLED')=='true','auditActorConfigured':bool(env.get('IRIS_INTERNAL_API_AUDIT_ACTOR')),'composeSha256':hashlib.sha256((STAGE/'before.compose.yml').read_bytes()).hexdigest()}
save('preflight-sanitized.json',report)
print(json.dumps(report))
