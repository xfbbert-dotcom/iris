"""Read-only recovery and real-request evidence. Semantic acceptance is assessed separately."""
import hashlib,json,os,subprocess
from pathlib import Path
ROOT=Path('/opt/iris/repository');P=ROOT/'evidence/pd-supervised-20261008b'
os.umask(0o077)
def load(name):return json.loads((P/name).read_text())
def run(args,input=None):
    r=subprocess.run(args,cwd=ROOT,input=input,capture_output=True,text=True,timeout=40)
    if r.returncode:raise RuntimeError('final inspection failed')
    return r.stdout
core=json.loads(run(['docker','inspect','iris-pilot-core-1']))[0]
env=dict(x.split('=',1) for x in core['Config']['Env'])
state=json.loads(run(['docker','exec','-i','iris-pilot-core-1','node','--input-type=module'],(P/'control.mjs').read_text()))
assert run(['git','rev-parse','HEAD']).strip()=='51937b954733020799e02f139abd32df74b3349c'
assert core['State']['Health']['Status']=='healthy'
assert core['Image']==load('before-services.json')['core']['image']
assert not state['control']['globalEnabled'] and not state['control']['desiredGlobalEnabled']
assert state['control']['capabilities']==load('before-control.json')['control']['capabilities']
assert state['policy']=={'version':'8','enabled':False}
assert not state['pd']['enabled'] and not state['pd']['running']
assert env==load('before-live-env.json')
assert (ROOT/'.env.pilot').read_bytes()==(P/'before.env').read_bytes()
assert (ROOT/'deploy/pilot/docker-compose.yml').read_bytes()==(P/'before.compose.yml').read_bytes()
for service,old in load('before-services.json').items():
    if service=='core':continue
    current=json.loads(run(['docker','inspect','iris-pilot-'+service+'-1']))[0]
    assert current['Id']==old['id'] and current['Image']==old['image']
session=list((P/'container-final').glob('pd-free-*'));assert len(session)==1
counts={k:len(list(session[0].glob(k+'-*.json'))) for k in ['pending','permit','outcome','final','uncertain']}
assert counts=={'pending':1,'permit':1,'outcome':1,'final':1,'uncertain':0}
stopped=json.loads((session[0]/'stopped.json').read_text())
assert stopped['reason']=='operator-stop' and stopped['uncertain'] is False
finals=[json.loads(p.read_text()) for p in session[0].glob('final-*.json')]
assert len(finals)==1 and finals[0]['status']=='accepted' and finals[0]['httpStatus']==200
permits=[json.loads(p.read_text()) for p in session[0].glob('permit-*.json')]
capture=load('private-final.json');v=capture['feishu']
assert capture['readOnly'] and len(capture['jobs'])==1 and len(capture['evaluations'])==1 and not capture['deliveries']
assert capture['jobs'][0]['state']=='completed' and capture['jobs'][0]['attempts']==1
assert not v['readFailures'] and len(v['bindingChecks'])==20 and all(x['contentHashMatches'] for x in v['bindingChecks'])
assert len(v['triggerChecks'])==1 and all(x['registrationHashMatches'] for x in v['triggerChecks'])
assert not state['deliveries']
assert sorted(state['jobs'],key=lambda x:x['state'])==[{'state':'cancelled','n':1},{'state':'completed','n':1}]
report={'kind':'supervised-pd-window-real-evaluation','capturedAt':state['at'],
 'app':'51937b954733020799e02f139abd32df74b3349c','image':core['Image'],'coreHealthy':True,
 'startedAt':load('started.json')['gate']['startedAt'],'stopped':stopped,'restoredAt':load('restored.json')['at'],
 'global':False,'desired':False,'pdEnabled':False,'policyVersion':state['policy']['version'],'policyEnabled':False,'controlRevision':state['control']['revision'],
 'capabilitiesRestored':True,'liveEnvEqual':True,'envByteEqual':True,'composeByteEqual':True,'nonCoreContainersUnchanged':True,
 'gateFiles':counts,'realDiscussionTriggers':1,'providerHttp':1,'reportedModelTokens':sum(f['reportedTokens'] for f in finals),'feishuOpinionSends':0,
 'requestRecords':finals,'permits':permits,'jobs':state['jobs'],'domainCounts':state['counts'],
 'semanticAcceptance':'separate-source-only-comparison-required','realFeishuOpinionAcceptance':'not-exercised',
 'feishuReadback':{'authRequests':v['authRequests'],'messageGets':v['messageGets'],'readFailures':0,'bindingChecks':20,'bindingChecksAllMatch':True,'triggerChecksAllMatch':True},
 'privateCaptureSha256':hashlib.sha256((P/'private-final.json').read_bytes()).hexdigest(),
 'watchdogRecoveryFailures':len(list(P.glob('watchdog-recovery-failed-*'))),'wiringSmoke':load('wiring-smoke.json'),'scriptDerivation':load('script-derivation.json')}
with (P/'final-sanitized.json').open('x') as f:json.dump(report,f,indent=2)
print(json.dumps(report))
