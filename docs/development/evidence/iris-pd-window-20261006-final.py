"""Read-only final probe; capture business output privately and emit only sanitized evidence."""
import hashlib,json,os,subprocess,time
from pathlib import Path
ROOT=Path('/opt/iris/repository');STAGE=ROOT/'evidence/pd-supervised-20261006'
os.umask(0o077)
def run(args,input=None):
    r=subprocess.run(args,cwd=ROOT,input=input,capture_output=True,text=True,timeout=40)
    if r.returncode:raise RuntimeError('final probe command failed')
    return r.stdout
def saved(name):return json.loads((STAGE/name).read_text())
core=json.loads(run(['docker','inspect','iris-pilot-core-1']))[0]
env=dict(x.split('=',1) for x in core['Config']['Env']);before=saved('before-live-env.json')
state=json.loads(run(['docker','exec','-i','iris-pilot-core-1','node','--input-type=module'],(STAGE/'control.mjs').read_text()))
private=json.loads(run(['docker','exec','-i','iris-pilot-core-1','node','--input-type=module'],(STAGE/'capture.mjs').read_text()))
with (STAGE/'private-final-capture.json').open('x') as f:json.dump(private,f)
with (STAGE/'private-final-control.json').open('x') as f:json.dump(state,f)
assert core['State']['Health']['Status']=='healthy'
assert core['Image']==saved('before-services.json')['core']['image']
assert not state['control']['globalEnabled'] and not state['control']['desiredGlobalEnabled']
assert state['control']['capabilities']==saved('before-control.json')['control']['capabilities']
assert state['policy']['enabled'] is False
assert not state['pd']['enabled'] and not state['pd']['running']
assert all(env.get(k)==v for k,v in before.items())
assert (ROOT/'.env.pilot').read_bytes()==(STAGE/'before.env').read_bytes()
assert (ROOT/'deploy/pilot/docker-compose.yml').read_bytes()==(STAGE/'before.compose.yml').read_bytes()
for service,old in saved('before-services.json').items():
    if service=='core':continue
    current=json.loads(run(['docker','inspect','iris-pilot-'+service+'-1']))[0]
    assert current['Id']==old['id'] and current['Image']==old['image']
session=list((STAGE/'container-final').glob('pd-free-*'))
assert len(session)==1
counts={kind:len(list(session[0].glob(kind+'-*.json'))) for kind in ['pending','permit','outcome','final','uncertain']}
assert all(v==0 for v in counts.values())
assert not private['jobs'] and not private['evaluations'] and not private['deliveries']
report={'kind':'supervised-pd-window-without-human-trigger','capturedAt':state['at'],
 'app':'51937b954733020799e02f139abd32df74b3349c','imageId':core['Image'],'coreHealthy':True,
 'startedAt':saved('started.json')['gate']['startedAt'],'stop':saved('restored.json')['gateStop']['ack'],
 'restoredAt':saved('restored.json')['at'],'global':False,'desired':False,'pdEnabled':False,
 'policyVersion':state['policy']['version'],'policyEnabled':False,'controlRevision':state['control']['revision'],
 'capabilitiesRestored':True,'envByteEqual':True,'liveEnvEqual':True,'composeByteEqual':True,
 'nonCoreContainersUnchanged':True,'wikiRestoredEnabled':env['IRIS_WIKI_SPACE_SYNC_ENABLED']=='true',
 'gateFiles':counts,'providerHttp':0,'reportedModelTokens':0,'realDiscussionTriggers':0,'feishuOpinionSends':0,
 'domainCounts':state['counts'],'pendingJobs':state['jobs'],'deliveries':state['deliveries'],
 'semanticAcceptance':'not-exercised','realFeishuAcceptance':'not-exercised',
 'wiringSmoke':saved('wiring-smoke.json'),'watchdogRecoveryFailures':len(list(STAGE.glob('watchdog-recovery-failed-*'))),
 'filesSha256':{p.name:hashlib.sha256(p.read_bytes()).hexdigest() for p in STAGE.iterdir() if p.suffix in ['.py','.mjs']}}
with (STAGE/'final-sanitized.json').open('x') as f:json.dump(report,f,indent=2)
print(json.dumps(report))
