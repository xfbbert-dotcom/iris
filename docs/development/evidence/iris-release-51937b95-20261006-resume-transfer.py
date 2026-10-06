"""Verify retained encrypted prefixes, then fetch only their missing 1 MiB ranges."""
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
import hashlib
import json
import math
from pathlib import Path
import shutil
import subprocess
import time

EV=Path(__file__).resolve().parent
PRIVATE=Path.home()/'AppData/Local/Iris/release-20261006-51937b95'
record=json.loads((EV/'iris-release-51937b95-20261006-backup.json').read_text())
parts=PRIVATE/'encrypted-parts'
tails=PRIVATE/'encrypted-tails'
archive=PRIVATE/Path(record['path']).name
assert not tails.exists() and not archive.exists()
tails.mkdir()
block=1048576
per=math.ceil(math.ceil(record['bytes']/block)/24)
meta=[]
for i in range(24):
    p=parts/f'{i:02d}.part'
    offset=i*per*block
    expected=min(per*block,record['bytes']-offset)
    size=p.stat().st_size
    assert 0<size<=expected
    meta.append({'part':i,'offset':offset,'expected':expected,'received':size,'sha256':hashlib.sha256(p.read_bytes()).hexdigest()})
remote='import json,hashlib\nitems='+repr(meta)+'\npath='+repr(record['path'])+'''\nresults=[]
with open(path,'rb') as f:
    for item in items:
        f.seek(item['offset'])
        results.append({'part':item['part'],'prefixMatches':hashlib.sha256(f.read(item['received'])).hexdigest()==item['sha256']})
print(json.dumps(results))
'''
r=subprocess.run(['ssh','-T','-o','BatchMode=yes','-o','ConnectTimeout=15','iris-vps','python3 -'],input=remote.encode(),capture_output=True,timeout=45)
assert r.returncode==0
prefixes=json.loads(r.stdout)
assert len(prefixes)==24 and all(x['prefixMatches'] for x in prefixes)
jobs=[]
for m in meta:
    left=m['expected']-m['received']
    cursor=m['offset']+m['received']
    while left:
        size=min(block,left)
        jobs.append({'index':len(jobs),'part':m['part'],'offset':cursor,'size':size})
        cursor+=size
        left-=size
start=time.monotonic()
print(json.dumps({'verifiedRetainedBytes':sum(m['received'] for m in meta),'missingBytes':sum(j['size'] for j in jobs),'oneMiBRanges':len(jobs)}),flush=True)

def copy_range(job):
    if job['index']<24: time.sleep(job['index']*0.3)
    p=tails/f"{job['index']:04d}.part"
    command=f"stty raw -echo; dd if={record['path']} bs=65536 iflag=skip_bytes,count_bytes skip={job['offset']} count={job['size']} status=none"
    with p.open('xb') as out:
        r=subprocess.run(['ssh','-tt','-o','BatchMode=yes','-o','ConnectTimeout=15','-o','IPQoS=none','iris-vps',command],
            stdin=subprocess.DEVNULL,stdout=out,stderr=subprocess.PIPE,timeout=120)
    if r.returncode or p.stat().st_size!=job['size']: raise RuntimeError('encrypted range failed: '+str(job['index']))

with ThreadPoolExecutor(max_workers=24) as pool:
    futures=[pool.submit(copy_range,j) for j in jobs]
    while not all(f.done() for f in futures):
        time.sleep(30)
        print(json.dumps({'elapsedSeconds':round(time.monotonic()-start),'completedRanges':sum(f.done() and f.exception() is None for f in futures),
            'failedRanges':sum(f.done() and f.exception() is not None for f in futures),'totalRanges':len(jobs)}),flush=True)
    for f in futures:f.result()
with archive.open('xb') as out:
    for m in meta:
        with (parts/f"{m['part']:02d}.part").open('rb') as inp: shutil.copyfileobj(inp,out)
        for j in jobs:
            if j['part']==m['part']:
                with (tails/f"{j['index']:04d}.part").open('rb') as inp: shutil.copyfileobj(inp,out)
assert archive.stat().st_size==record['bytes']
assert hashlib.sha256(archive.read_bytes()).hexdigest()==record['sha256']
report={'capturedAt':datetime.now(timezone.utc).isoformat(),'transport':'verified-prefix SSH raw PTY range continuation',
    'prefixesAllMatchRemote':True,'retainedBytes':sum(m['received'] for m in meta),'rangeCount':len(jobs),'rangeTimeoutSeconds':120,
    'streams':24,'automaticRetries':0,'encryptedArchiveBytes':archive.stat().st_size,'sha256':record['sha256'],
    'fullHashMatches':True,'elapsedSeconds':round(time.monotonic()-start,2)}
(EV/'iris-release-51937b95-20261006-transfer.json').write_text(json.dumps(report,indent=2)+'\n')
print(json.dumps(report),flush=True)
