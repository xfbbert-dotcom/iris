"""Create a fresh, private window from the reviewed October 6 operation scripts.
Only records/read-only preflight are executed here; activation remains a separate step.
"""
import ast,hashlib,json,os,subprocess
from pathlib import Path
ROOT=Path('/opt/iris/repository')
OLD=ROOT/'evidence/pd-supervised-20261006'
NEW=ROOT/'evidence/pd-supervised-20261007'
os.umask(0o077)
previous=json.loads((OLD/'final-sanitized.json').read_text())
assert previous['providerHttp']==0 and previous['realDiscussionTriggers']==0
assert previous['policyVersion']=='2' and previous['policyEnabled'] is False
assert previous['global'] is False and previous['desired'] is False
names=['control.mjs','gate.mjs','ops.py','preflight.py','capture.mjs',
       'proactive-discussion-free-gate.mjs','proactive-discussion-free-gate-wiring-smoke.mjs']
sources={name:(OLD/name).read_bytes() for name in names}
assert all(hashlib.sha256(value).hexdigest()==previous['filesSha256'][name] for name,value in sources.items())
assert not NEW.exists()
NEW.mkdir(mode=0o700)
changes={}
for name,raw in sources.items():
    text=raw.decode().replace('20261006','20261007')
    if name=='preflight.py':
        text=text.replace("assert all(n==0 for n in snapshot['counts'].values())", "assert snapshot['counts']==json.loads((ROOT/'evidence/pd-supervised-20261006/final-sanitized.json').read_text())['domainCounts']\nassert snapshot['policy']=={'version':'2','enabled':False}")
        text=text.replace(",'IRIS_WIKI_SPACE_SYNC_ENABLED'",'')
        text=text.replace("'auditActorConfigured':", "'wikiInitiallyEnabled':env.get('IRIS_WIKI_SPACE_SYNC_ENABLED')=='true','auditActorConfigured':")
    if name=='ops.py':
        text=text.replace("assert all(v==0 for v in s['counts'].values())", "assert s['counts']==read('before-control.json')['counts']\n        assert s['policy']==read('before-control.json')['policy']")
    if name=='capture.mjs':
        text=text.replace("const FROM = '2026-10-06T07:13:43.000Z';",'const FROM = process.env.PD_WINDOW_FROM;')
        text=text.replace("const THROUGH = '2026-10-06T07:28:43.000Z';",'const THROUGH = process.env.PD_WINDOW_THROUGH;\nassert.ok(Number.isFinite(Date.parse(FROM)) && Date.parse(THROUGH)>=Date.parse(FROM));')
    if name.endswith('.py'):ast.parse(text)
    with (NEW/name).open('x') as f:f.write(text)
    changes[name]={'fromSha256':hashlib.sha256(raw).hexdigest(),'toSha256':hashlib.sha256((NEW/name).read_bytes()).hexdigest()}
with (NEW/'script-derivation.json').open('x') as f:json.dump({'sourceCommit':'a2d5f412','changes':changes},f,indent=2)
result=subprocess.run(['python3',str(NEW/'preflight.py')],capture_output=True,text=True,timeout=50)
with (NEW/'preflight-output.txt').open('x') as f:f.write(result.stdout+result.stderr)
if result.returncode:raise RuntimeError('fresh preflight failed; inspect private record')
print(result.stdout)
