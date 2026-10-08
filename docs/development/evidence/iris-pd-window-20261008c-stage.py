"""Fresh substantive-discussion window after explicit member readiness; preserve prior jobs."""
import ast,hashlib,json,os,subprocess
from pathlib import Path
ROOT=Path('/opt/iris/repository')
OLD=ROOT/'evidence/pd-supervised-20261008b'
NEW=ROOT/'evidence/pd-supervised-20261008c'
os.umask(0o077)
previous=json.loads((OLD/'final-sanitized.json').read_text())
assert previous['providerHttp']==1 and previous['realDiscussionTriggers']==1
assert previous['policyVersion']=='8' and previous['policyEnabled'] is False
assert previous['global'] is False and previous['desired'] is False
assert sorted(previous['jobs'],key=lambda row:row['state'])==[{'state':'cancelled','n':1},{'state':'completed','n':1}]
assert previous['domainCounts']=={'proactive_discussion_policies':1,'proactive_discussion_groups':1,
    'proactive_discussion_jobs':2,'proactive_discussion_evaluations':1,'proactive_discussion_issues':0,
    'proactive_discussion_deliveries':0,'proactive_discussion_sources':21,'proactive_discussion_events':21}
names=['control.mjs','gate.mjs','ops.py','preflight.py','capture.mjs',
       'proactive-discussion-free-gate.mjs','proactive-discussion-free-gate-wiring-smoke.mjs']
sources={name:(OLD/name).read_bytes() for name in names}
assert all(hashlib.sha256(raw).hexdigest()==previous['scriptDerivation']['changes'][name]['toSha256'] for name,raw in sources.items())
assert not NEW.exists()
NEW.mkdir(mode=0o700)
changes={}
for name,raw in sources.items():
    text=raw.decode().replace('20261008b','20261008c')
    if name=='preflight.py':
        replacements={
            "ROOT/'evidence/pd-supervised-20261008/final-sanitized.json'":"ROOT/'evidence/pd-supervised-20261008b/final-sanitized.json'",
            "assert snapshot['policy']=={'version':'6','enabled':False}":"assert snapshot['policy']=={'version':'8','enabled':False}",
            "snapshot['jobs']==[{'state':'cancelled','n':1}]":"sorted(snapshot['jobs'],key=lambda row:row['state'])==[{'state':'cancelled','n':1},{'state':'completed','n':1}]"
        }
        for old,new in replacements.items():
            assert text.count(old)==1
            text=text.replace(old,new)
    if name.endswith('.py'):ast.parse(text)
    output=text.encode()
    with (NEW/name).open('xb') as f:f.write(output)
    changes[name]={'fromSha256':hashlib.sha256(raw).hexdigest(),'toSha256':hashlib.sha256(output).hexdigest()}
with (NEW/'script-derivation.json').open('x') as f:
    json.dump({'operationSource':'20261008b','toolFixCommit':'749491868d5e6e422d5c26729511705176dc98ae','changes':changes},f,indent=2)
result=subprocess.run(['python3',str(NEW/'preflight.py')],capture_output=True,text=True,timeout=50)
with (NEW/'preflight-output.txt').open('x') as f:f.write(result.stdout+result.stderr)
if result.returncode:raise RuntimeError('fresh preflight failed; inspect private record')
print(result.stdout)
