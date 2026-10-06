"""Read-only production inspection; save private baseline, emit only bounded metadata."""
import hashlib,json,os,subprocess
from pathlib import Path
ROOT=Path('/opt/iris/repository')
STAGE=ROOT/'evidence/pd-supervised-20261006'
os.umask(0o077)
def run(args,input=None):
    p=subprocess.run(args,cwd=ROOT,input=input,capture_output=True,text=True,timeout=40)
    if p.returncode: raise RuntimeError('preflight command failed: '+args[0])
    return p.stdout
def save(name,data):
    with (STAGE/name).open('x') as f: json.dump(data,f)
assert STAGE.is_dir() and not (STAGE/'before.env').exists()
assert run(['git','rev-parse','HEAD']).strip()=='51937b954733020799e02f139abd32df74b3349c'
containers={s:json.loads(run(['docker','inspect','iris-pilot-'+s+'-1']))[0] for s in ['core','ai-worker','caddy','postgres','redis','embedding-model']}
core=containers['core']; env=dict(x.split('=',1) for x in core['Config']['Env'])
assert core['State']['Health']['Status']=='healthy'
assert core['Image']=='sha256:d1d4e7f732efbfe205bed9ece9bbce37f4531c21e5b52042c21d8029f06446f9'
save('before-live-env.json',env)
save('before-services.json',{s:{'id':c['Id'],'image':c['Image']} for s,c in containers.items()})
for name,source in [('before.env','.env.pilot'),('before.compose.yml','deploy/pilot/docker-compose.yml')]:
    with (STAGE/name).open('xb') as f:f.write((ROOT/source).read_bytes())
snapshot=json.loads(run(['docker','exec','-i','iris-pilot-core-1','node','--input-type=module'],(STAGE/'control.mjs').read_text()))
save('before-control.json',snapshot)
c=snapshot['control']
assert not c['globalEnabled'] and not c['desiredGlobalEnabled'] and c['persistence']['ok']
assert not c['capabilities']['proactiveSpeech']
assert all(n==0 for n in snapshot['counts'].values())
off=['IRIS_PROACTIVE_SIGNAL_PLANNER_ENABLED','IRIS_PROACTIVE_SIGNAL_DELIVERY_ENABLED','IRIS_MEMORY_EXTRACTION_ENABLED','IRIS_KNOWLEDGE_CONFLICT_ENABLED','IRIS_WIKI_SPACE_SYNC_ENABLED','IRIS_FEISHU_TASK_CREATION_ENABLED']
assert all(env.get(k,'false')=='false' for k in off)
assert env['IRIS_EMBEDDING_BASE_URL']=='http://embedding-model:11434/v1'
assert all(c['capabilities'][k] is False for k in ['generateTaskDrafts','createFeishuTasks','writeKnowledgeBase','updateManagedKnowledge','callExternalTools'])
assert c['capabilities']['readGroupContext'] and 'oc_637a9aca45f01943477f4e17f1fc5b9a' not in c['disabledGroupIds']
report={'at':snapshot['at'],'ok':True,'app':'51937b95','coreHealthy':True,'global':False,'desired':False,'revision':c['revision'],'capabilities':c['capabilities'],'disabledGroups':len(c['disabledGroupIds']),'targetDisabled':False,'domainCounts':snapshot['counts'],'offEntrypoints':{k:env.get(k,'false') for k in off},'embeddingLocal':True,'auditActorConfigured':bool(env.get('IRIS_INTERNAL_API_AUDIT_ACTOR')),'composeSha256':hashlib.sha256((STAGE/'before.compose.yml').read_bytes()).hexdigest()}
save('preflight-sanitized.json',report)
print(json.dumps(report))
