"""Fresh window after an explicit renewed readiness reply; no old task replay or budget reuse."""
import ast,hashlib,json,os,subprocess
from pathlib import Path
ROOT=Path('/opt/iris/repository')
OLD=ROOT/'evidence/pd-supervised-20261008'
NEW=ROOT/'evidence/pd-supervised-20261008b'
os.umask(0o077)
previous=json.loads((OLD/'final-sanitized.json').read_text())
assert previous['providerHttp']==0 and previous['realDiscussionTriggers']==0
assert previous['policyVersion']=='6' and previous['policyEnabled'] is False
assert previous['global'] is False and previous['desired'] is False
assert previous['jobs']==[{'state':'cancelled','n':1}] and previous['domainCounts']['proactive_discussion_events']==14
names=['control.mjs','gate.mjs','ops.py','preflight.py','capture.mjs',
       'proactive-discussion-free-gate.mjs','proactive-discussion-free-gate-wiring-smoke.mjs']
sources={name:(OLD/name).read_bytes() for name in names}
assert all(hashlib.sha256(raw).hexdigest()==previous['scriptDerivation']['changes'][name]['toSha256'] for name,raw in sources.items())
assert not NEW.exists()
NEW.mkdir(mode=0o700)
changes={}
for name,raw in sources.items():
    text=raw.decode().replace('20261008','20261008b')
    if name=='preflight.py':
        old="ROOT/'evidence/pd-supervised-20261007/final-sanitized.json'"
        assert text.count(old)==1
        text=text.replace(old,"ROOT/'evidence/pd-supervised-20261008/final-sanitized.json'")
        old="assert snapshot['policy']=={'version':'4','enabled':False}"
        assert text.count(old)==1
        text=text.replace(old,"assert snapshot['policy']=={'version':'6','enabled':False}")
    if name.endswith('.py'):ast.parse(text)
    output=text.encode()
    with (NEW/name).open('xb') as f:f.write(output)
    changes[name]={'fromSha256':hashlib.sha256(raw).hexdigest(),'toSha256':hashlib.sha256(output).hexdigest()}
with (NEW/'script-derivation.json').open('x') as f:
    json.dump({'operationSource':'20261008','toolFixCommit':'749491868d5e6e422d5c26729511705176dc98ae','changes':changes},f,indent=2)
result=subprocess.run(['python3',str(NEW/'preflight.py')],capture_output=True,text=True,timeout=50)
with (NEW/'preflight-output.txt').open('x') as f:f.write(result.stdout+result.stderr)
if result.returncode:raise RuntimeError('fresh preflight failed; inspect private record')
print(result.stdout)
