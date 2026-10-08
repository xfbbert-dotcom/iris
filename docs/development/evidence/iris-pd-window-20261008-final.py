"""Read-only final check after operator connection failure; never emit secret configuration."""
import hashlib,json,os,subprocess
from pathlib import Path
ROOT=Path('/opt/iris/repository');P=ROOT/'evidence/pd-supervised-20261008'
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
assert state['policy']=={'version':'6','enabled':False}
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
assert all(n==0 for n in counts.values())
stopped=json.loads((session[0]/'stopped.json').read_text())
assert stopped['reason']=='operator-stop' and stopped['uncertain'] is False
capture=load('private-capture.json')
assert capture['readOnly'] and not capture['jobs'] and not capture['evaluations'] and not capture['deliveries']
assert state['jobs']==[{'state':'cancelled','n':1}] and not state['deliveries']
smoke=load('wiring-smoke.json')
assert smoke['timing']=={'permitWaitMs':60000,'requestMs':30000,'clientTimeoutMs':120000}
report={'kind':'supervised-pd-window-operator-connection-failure','capturedAt':state['at'],
 'app':'51937b954733020799e02f139abd32df74b3349c','image':core['Image'],'coreHealthy':True,
 'startedAt':load('started.json')['gate']['startedAt'],'stopped':stopped,'restoredAt':load('restored.json')['at'],
 'operatorUiObservation':{'observedAt':'2026-10-08T05:09:12.917Z','model':'qwen3.8-max','displayedRemaining':'533.62K / 1M','expiresOn':'2026-12-18','freeExhaustionStop':True,'permitWritten':False,'basis':'preparation only; no pending request'},
 'global':False,'desired':False,'pdEnabled':False,'policyVersion':state['policy']['version'],'policyEnabled':False,'controlRevision':state['control']['revision'],
 'capabilitiesRestored':True,'liveEnvEqual':True,'envByteEqual':True,'composeByteEqual':True,'nonCoreContainersUnchanged':True,
 'gateFiles':counts,'realDiscussionTriggers':0,'providerHttp':0,'reportedModelTokens':0,'feishuOpinionSends':0,
 'jobs':state['jobs'],'domainCounts':state['counts'],'semanticAcceptance':'not-exercised','realFeishuOpinionAcceptance':'not-exercised',
 'watchdogRecoveryFailures':len(list(P.glob('watchdog-recovery-failed-*'))),'wiringSmoke':smoke,'scriptDerivation':load('script-derivation.json'),
 'connectionFailure':{'domainAttempts':['closed','closed','timeout'],'systemDnsAddress':'198.18.0.94','dnsOverHttpsAddress':'43.160.229.172','recovery':'HostName override with original HostKeyAlias and StrictHostKeyChecking=yes','rootCauseAttribution':'domain path failed, direct path succeeded; proxy internals not established'}}
with (P/'final-sanitized.json').open('x') as f:json.dump(report,f,indent=2)
print(json.dumps(report))
