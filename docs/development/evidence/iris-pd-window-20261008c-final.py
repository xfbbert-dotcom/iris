"""Read-only recovery and delivery evidence; semantic acceptance is assessed separately."""
import hashlib,json,os,subprocess
from pathlib import Path
ROOT=Path('/opt/iris/repository');P=ROOT/'evidence/pd-supervised-20261008c'
os.umask(0o077)

def load(name):return json.loads((P/name).read_text())

def run(args,input=None):
    r=subprocess.run(args,cwd=ROOT,input=input,capture_output=True,text=True,timeout=40)
    if r.returncode:raise RuntimeError('final inspection failed')
    return r.stdout

tables=['proactive_discussion_policies','proactive_discussion_groups','proactive_discussion_jobs',
        'proactive_discussion_evaluations','proactive_discussion_issues','proactive_discussion_deliveries',
        'proactive_discussion_sources','proactive_discussion_events']
before=load('before-control.json')
assert before['counts']==dict(zip(tables,[1,1,2,1,0,0,21,21]))
assert before['policy']=={'version':'8','enabled':False}
core=json.loads(run(['docker','inspect','iris-pilot-core-1']))[0]
env=dict(x.split('=',1) for x in core['Config']['Env'])
state=json.loads(run(['docker','exec','-i','iris-pilot-core-1','node','--input-type=module'],(P/'control.mjs').read_text()))
assert run(['git','rev-parse','HEAD']).strip()=='51937b954733020799e02f139abd32df74b3349c'
assert core['State']['Health']['Status']=='healthy'
assert core['Image']==load('before-services.json')['core']['image']
assert not state['control']['globalEnabled'] and not state['control']['desiredGlobalEnabled']
assert state['control']['capabilities']==before['control']['capabilities']
assert state['policy']=={'version':'10','enabled':False}
assert not state['pd']['enabled'] and not state['pd']['running']
assert env==load('before-live-env.json')
assert (ROOT/'.env.pilot').read_bytes()==(P/'before.env').read_bytes()
assert (ROOT/'deploy/pilot/docker-compose.yml').read_bytes()==(P/'before.compose.yml').read_bytes()
for service,old in load('before-services.json').items():
    if service=='core':continue
    current=json.loads(run(['docker','inspect','iris-pilot-'+service+'-1']))[0]
    assert current['Id']==old['id'] and current['Image']==old['image']
assert state['counts']==dict(zip(tables,[1,1,3,2,1,1,63,42]))
assert sorted(state['jobs'],key=lambda x:x['state'])==[{'state':'cancelled','n':1},{'state':'completed','n':2}]
assert state['deliveries']==[{'state':'sent','n':1}]

session=list((P/'container-final').glob('pd-free-*'));assert len(session)==1
counts={k:len(list(session[0].glob(k+'-*.json'))) for k in ['pending','permit','outcome','final','uncertain']}
assert counts=={'pending':4,'permit':4,'outcome':4,'final':4,'uncertain':0}
stopped=json.loads((session[0]/'stopped.json').read_text())
assert stopped['reason']=='operator-stop' and stopped['uncertain'] is False
records={kind:[json.loads(p.read_text()) for p in sorted(session[0].glob(kind+'-*.json'))]
         for kind in ['pending','permit','outcome','final']}
finals=records['final'];outcomes=records['outcome'];permits=records['permit']
by_id={kind:{row['requestId']:row for row in rows} for kind,rows in records.items()}
assert all(len(rows)==4 and set(rows)==set(by_id['final']) for rows in by_id.values())
for final in finals:
    request_id=final['requestId']
    assert all(by_id[kind][request_id]['requestHash']==final['requestHash'] for kind in by_id)
    assert all(by_id[kind][request_id]['model']=='qwen3.8-max' for kind in by_id)
    assert by_id['outcome'][request_id]['status']=='dispatch-prepared'
    assert final['status']=='accepted' and isinstance(final['httpStatus'],int) and 200<=final['httpStatus']<300
    assert final['sentAt'] and final['finishedAt'] and len(final['responseSha256'])==64
    assert isinstance(final['reportedTokens'],int) and final['reportedTokens']>0
# Gate metadata contains hashes and counts, never model content or credentials.
record_fields={'requestId','requestHash','model','startedAt','status','sentAt','httpStatus',
               'responseSha256','reportedTokens','finishedAt'}
assert all(set(row)<=record_fields for row in finals+outcomes)
assert all(set(row)=={'requestId','requestHash','model','remainingTokens','observedAt','expiresAt','freeExhaustionStop'} for row in permits)

capture=load('private-final.json');v=capture['feishu']
assert capture['readOnly'] and len(capture['jobs'])==1 and len(capture['evaluations'])==1 and len(capture['deliveries'])==1
assert capture['jobs'][0]['state']=='completed' and capture['jobs'][0]['attempts']==1
assert capture['deliveries'][0]['state']=='sent'
assert v['attempted'] and not v['readFailures'] and v['messageGets']==21
assert len(v['humanMessages'])==20 and len(v['assistantMessages'])==1
assert len(v['bindingChecks'])==40 and all(x['found'] and x['contentHashMatches'] for x in v['bindingChecks'])
assert len(v['triggerChecks'])==1 and all(x['found'] and x['registrationHashMatches'] for x in v['triggerChecks'])
assert len(v['deliveryChecks'])==1 and all(x['found'] and x['state']=='sent' and x['textExactlyMatches'] and x['parentMatchesTrigger'] for x in v['deliveryChecks'])
report={'kind':'supervised-pd-window-real-delivery','capturedAt':state['at'],
 'app':'51937b954733020799e02f139abd32df74b3349c','image':core['Image'],'coreHealthy':True,
 'startedAt':load('started.json')['gate']['startedAt'],'stopped':stopped,'restoredAt':load('restored.json')['at'],
 'global':state['control']['globalEnabled'],'desired':state['control']['desiredGlobalEnabled'],
 'pdEnabled':state['pd']['enabled'],'policyVersion':state['policy']['version'],'policyEnabled':state['policy']['enabled'],'controlRevision':state['control']['revision'],
 'capabilitiesRestored':True,'liveEnvEqual':True,'envByteEqual':True,'composeByteEqual':True,'nonCoreContainersUnchanged':True,
 'gateFiles':counts,'realDiscussionTriggers':len(capture['jobs']),'providerHttp':sum('sentAt' in f for f in finals),
 'reportedModelTokens':sum(f['reportedTokens'] for f in finals),'feishuOpinionSends':sum(d['state']=='sent' for d in capture['deliveries']),
 'requestRecords':finals,'outcomeRecords':outcomes,'permits':permits,'jobs':state['jobs'],'deliveries':state['deliveries'],
 'jobAttempts':[job['attempts'] for job in capture['jobs']],'domainCounts':state['counts'],'baselineDomainCounts':before['counts'],
 'semanticAcceptance':'separate-source-only-comparison-required','realFeishuDeliveryAcceptance':'receipt-text-and-parent-match',
 'feishuReadback':{'authRequests':v['authRequests'],'messageGets':v['messageGets'],'readFailures':len(v['readFailures']),
   'humanMessages':len(v['humanMessages']),'assistantMessages':len(v['assistantMessages']),
   'bindingChecks':len(v['bindingChecks']),'bindingChecksAllMatch':all(x['contentHashMatches'] for x in v['bindingChecks']),
   'triggerChecks':len(v['triggerChecks']),'triggerChecksAllMatch':all(x['registrationHashMatches'] for x in v['triggerChecks']),
   'deliveryChecks':len(v['deliveryChecks']),'deliveryTextExactlyMatches':all(x['textExactlyMatches'] for x in v['deliveryChecks']),
   'deliveryParentMatchesTrigger':all(x['parentMatchesTrigger'] for x in v['deliveryChecks'])},
 'privateCaptureSha256':hashlib.sha256((P/'private-final.json').read_bytes()).hexdigest(),
 'watchdogRecoveryFailures':len(list(P.glob('watchdog-recovery-failed-*'))),'wiringSmoke':load('wiring-smoke.json'),'scriptDerivation':load('script-derivation.json')}
with (P/'final-sanitized.json').open('x') as f:json.dump(report,f,indent=2)
print(json.dumps(report))
