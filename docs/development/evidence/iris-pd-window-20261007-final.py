"""Confirm stop/recovery and distinguish a permit timeout from model or Feishu failure."""
import hashlib,json,os,subprocess
from pathlib import Path
ROOT=Path('/opt/iris/repository');P=ROOT/'evidence/pd-supervised-20261007'
os.umask(0o077)
def load(name):return json.loads((P/name).read_text())
def run(args,input=None):
    r=subprocess.run(args,cwd=ROOT,input=input,capture_output=True,text=True,timeout=40)
    if r.returncode:raise RuntimeError('final inspection failed')
    return r.stdout
core=json.loads(run(['docker','inspect','iris-pilot-core-1']))[0]
env=dict(x.split('=',1) for x in core['Config']['Env'])
state=json.loads(run(['docker','exec','-i','iris-pilot-core-1','node','--input-type=module'],(P/'control.mjs').read_text()))
assert core['State']['Health']['Status']=='healthy'
assert core['Image']==load('before-services.json')['core']['image']
assert not state['control']['globalEnabled'] and not state['control']['desiredGlobalEnabled']
assert state['control']['capabilities']==load('before-control.json')['control']['capabilities']
assert not state['policy']['enabled'] and not state['pd']['enabled'] and not state['pd']['running']
assert env==load('before-live-env.json')
assert (ROOT/'.env.pilot').read_bytes()==(P/'before.env').read_bytes()
assert (ROOT/'deploy/pilot/docker-compose.yml').read_bytes()==(P/'before.compose.yml').read_bytes()
for service,old in load('before-services.json').items():
    if service=='core':continue
    current=json.loads(run(['docker','inspect','iris-pilot-'+service+'-1']))[0]
    assert current['Id']==old['id'] and current['Image']==old['image']
session=list((P/'container-final').glob('pd-free-*'))
assert len(session)==1
counts={kind:len(list(session[0].glob(kind+'-*.json'))) for kind in ['pending','permit','outcome','final','uncertain']}
assert counts=={'pending':1,'permit':0,'outcome':0,'final':0,'uncertain':0}
pending=json.loads(next(session[0].glob('pending-*.json')).read_text())
stopped=json.loads((session[0]/'stopped.json').read_text())
assert stopped['uncertain'] is False
capture=load('private-capture.json')
assert len(capture['jobs'])==1 and capture['jobs'][0]['state']=='cancelled'
assert not capture['evaluations'] and not capture['deliveries']
report={'kind':'supervised-pd-window-permit-timeout','capturedAt':state['at'],
 'app':'51937b954733020799e02f139abd32df74b3349c','image':core['Image'],'coreHealthy':True,
 'startedAt':load('started.json')['gate']['startedAt'],'pending':pending,'stopped':stopped,
 'operatorUiObservation':{'observedAt':'2026-10-07T09:47:48.624Z','model':'qwen3.8-max','displayedRemaining':'533.62K / 1M','expiresOn':'2026-12-18','freeExhaustionStop':True,'permitWritten':False,'basis':'visible quota UI after reload; not billing audit'},
 'restoredAt':load('restored.json')['at'],'global':False,'desired':False,'pdEnabled':False,
 'policyVersion':state['policy']['version'],'policyEnabled':False,'controlRevision':state['control']['revision'],
 'capabilitiesRestored':True,'liveEnvEqual':True,'envByteEqual':True,'composeByteEqual':True,'nonCoreContainersUnchanged':True,
 'gateFiles':counts,'realDiscussionTriggers':1,'providerHttp':0,'reportedModelTokens':0,'feishuOpinionSends':0,
 'jobs':[{'state':j['state'],'attempts':j['attempts'],'lastError':j['last_error']} for j in capture['jobs']],
 'domainCounts':state['counts'],'semanticAcceptance':'not-exercised','realFeishuOpinionAcceptance':'not-exercised',
 'watchdogRecoveryFailures':len(list(P.glob('watchdog-recovery-failed-*'))),'wiringSmoke':load('wiring-smoke.json'),
 'scriptDerivation':load('script-derivation.json')}
with (P/'final-sanitized.json').open('x') as f:json.dump(report,f,indent=2)
print(json.dumps(report))
