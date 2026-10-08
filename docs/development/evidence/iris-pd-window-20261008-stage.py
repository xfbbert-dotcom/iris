"""Derive one fresh private window. This step runs read-only preflight, not activation."""
import ast,hashlib,json,os,subprocess
from pathlib import Path
ROOT=Path('/opt/iris/repository')
OLD=ROOT/'evidence/pd-supervised-20261007'
NEW=ROOT/'evidence/pd-supervised-20261008'
INPUT=ROOT/'evidence/pd-supervised-20261008-input'
os.umask(0o077)
previous=json.loads((OLD/'final-sanitized.json').read_text())
assert previous['providerHttp']==0 and previous['realDiscussionTriggers']==1
assert previous['policyVersion']=='4' and previous['policyEnabled'] is False
assert previous['global'] is False and previous['desired'] is False
assert previous['jobs']==[{'state':'cancelled','attempts':2,'lastError':'policy_or_trigger_invalid'}]
assert previous['domainCounts']==dict(zip(['proactive_discussion_policies','proactive_discussion_groups',
    'proactive_discussion_jobs','proactive_discussion_evaluations','proactive_discussion_issues',
    'proactive_discussion_deliveries','proactive_discussion_sources','proactive_discussion_events'],[1,1,1,0,0,0,0,12]))
names=['control.mjs','gate.mjs','ops.py','preflight.py','capture.mjs',
       'proactive-discussion-free-gate.mjs','proactive-discussion-free-gate-wiring-smoke.mjs']
sources={name:(OLD/name).read_bytes() for name in names}
assert all(hashlib.sha256(raw).hexdigest()==previous['scriptDerivation']['changes'][name]['toSha256'] for name,raw in sources.items())
updated={'proactive-discussion-free-gate.mjs':'7c4fe0cd9d8b1b4bd6bf5fd0270c31e35e0da0bffcf5e05fd73d169b92644502',
         'proactive-discussion-free-gate-wiring-smoke.mjs':'49a48a1b870664b09082b2e592949e2a97f93bc0a0fada61b1b3159a50ee2ce5'}
fresh={name:(INPUT/name).read_bytes() for name in updated}
assert all(hashlib.sha256(raw).hexdigest()==updated[name] for name,raw in fresh.items())
def replace_once(text,old,new):
    assert text.count(old)==1,'unexpected derivation source'
    return text.replace(old,new)
assert not NEW.exists()
NEW.mkdir(mode=0o700)
changes={}
for name,raw in sources.items():
    text=raw.decode().replace('20261007','20261008')
    if name=='preflight.py':
        text=replace_once(text,"ROOT/'evidence/pd-supervised-20261006/final-sanitized.json'","ROOT/'evidence/pd-supervised-20261007/final-sanitized.json'")
        text=replace_once(text,"assert snapshot['policy']=={'version':'2','enabled':False}",
            "assert snapshot['policy']=={'version':'4','enabled':False}\nassert snapshot['jobs']==[{'state':'cancelled','n':1}] and snapshot['deliveries']==[]")
    if name=='ops.py':
        text=replace_once(text,'import hashlib,json,os,re,subprocess,sys,time','import datetime,hashlib,json,os,re,subprocess,sys,time')
        text=replace_once(text,"'IRIS_PROACTIVE_DISCUSSION_MODEL_TIMEOUT_MS':'60000'","'IRIS_PROACTIVE_DISCUSSION_MODEL_TIMEOUT_MS':'120000'")
        text=replace_once(text,"write('started.json',{'at':time.time(),'gate':g})",
            "write('started.json',{'at':datetime.datetime.fromisoformat(g['startedAt'].replace('Z','+00:00')).timestamp(),'gate':g})")
        text=replace_once(text,"write('wiring-smoke.json',smoke);unchanged_services()",
            "assert smoke['timing']=={'permitWaitMs':60000,'requestMs':30000,'clientTimeoutMs':120000}\n        assert smoke['gateSha256']=='"+updated['proactive-discussion-free-gate.mjs']+"'\n        write('wiring-smoke.json',smoke);unchanged_services()")
    if name=='gate.mjs':
        text=replace_once(text,'import {createFreeGate}', 'import {createFreeGate,FREE_GATE_TIMING}')
        text=replace_once(text,'await gate.start(8765);',
            "if(process.env.IRIS_PROACTIVE_DISCUSSION_MODEL_TIMEOUT_MS!==String(FREE_GATE_TIMING.clientTimeoutMs)) throw Error('client timing mismatch');\nconst startedAt=new Date().toISOString();\nawait gate.start(8765);")
        text=replace_once(text,'startedAt:new Date().toISOString()','startedAt,timing:FREE_GATE_TIMING')
    output=fresh[name] if name in fresh else text.encode()
    if name.endswith('.py'):ast.parse(output.decode())
    with (NEW/name).open('xb') as f:f.write(output)
    changes[name]={'fromSha256':hashlib.sha256(raw).hexdigest(),'toSha256':hashlib.sha256(output).hexdigest()}
with (NEW/'script-derivation.json').open('x') as f:
    json.dump({'operationSource':'20261007','toolFixCommit':'749491868d5e6e422d5c26729511705176dc98ae','changes':changes},f,indent=2)
result=subprocess.run(['python3',str(NEW/'preflight.py')],capture_output=True,text=True,timeout=50)
with (NEW/'preflight-output.txt').open('x') as f:f.write(result.stdout+result.stderr)
if result.returncode:raise RuntimeError('fresh preflight failed; inspect private record')
print(result.stdout)
