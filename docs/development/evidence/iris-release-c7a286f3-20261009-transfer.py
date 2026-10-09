"""Copy only this release's encrypted backup with bounded, non-retrying SSH ranges."""
from concurrent.futures import ThreadPoolExecutor, wait, FIRST_COMPLETED
from datetime import datetime, timezone
import hashlib
import json
import math
from pathlib import Path
import re
import shlex
import shutil
import subprocess
import time

EV=Path(__file__).resolve().parent
PRIVATE=Path('C:/Users/59912/AppData/Local/Iris/release-20261009-c7a286f3')
record=json.loads((EV/'iris-release-c7a286f3-20261009-backup.json').read_text(encoding='utf-8-sig'))
assert re.fullmatch(r'/opt/iris/repository/evidence/release-20261009-c7a286f3/backups/iris-\d{8}T\d{6}Z\.bundle\.tar\.age',record['path'])
assert record['sourceCommit']=='51937b954733020799e02f139abd32df74b3349c'
parts=PRIVATE/'encrypted-parts'; assert not parts.exists(); parts.mkdir()
archive=PRIVATE/Path(record['path']).name; assert not archive.exists()
block=4*1024*1024; jobs=[{'index':i,'offset':i*block,'size':min(block,record['bytes']-i*block)} for i in range(math.ceil(record['bytes']/block))]
SSH=['ssh','-tt','-o','BatchMode=yes','-o','HostName=43.160.229.172','-o','HostKeyAlias=iris.quello.cn','-o','StrictHostKeyChecking=yes','-o','ConnectTimeout=10','-o','ServerAliveInterval=5','-o','ServerAliveCountMax=2','-o','IPQoS=none','iris-vps']
started=time.monotonic()

def copy(job):
    path=parts/(str(job['index']).zfill(4)+'.part')
    command='stty raw -echo; dd if='+shlex.quote(record['path'])+' bs=65536 iflag=skip_bytes,count_bytes skip='+str(job['offset'])+' count='+str(job['size'])+' status=none'
    with path.open('xb') as out:
        p=subprocess.run(SSH+[command],stdin=subprocess.DEVNULL,stdout=out,stderr=subprocess.PIPE,timeout=90)
    if p.returncode or path.stat().st_size!=job['size']: raise RuntimeError('encrypted range failed: '+str(job['index']))
    return job['size']

done_bytes=0; completed=0
with ThreadPoolExecutor(max_workers=16) as pool:
    pending={pool.submit(copy,j):j for j in jobs[:16]}; next_index=len(pending)
    while pending:
        done,_=wait(pending,timeout=20,return_when=FIRST_COMPLETED)
        for future in done:
            done_bytes+=future.result(); completed+=1; del pending[future]
            if next_index<len(jobs):
                j=jobs[next_index];pending[pool.submit(copy,j)]=j;next_index+=1
        if not done or completed%16==0 or completed==len(jobs):
            print(json.dumps({'elapsedSeconds':round(time.monotonic()-started),'completedRanges':completed,'totalRanges':len(jobs),'verifiedLengthBytes':done_bytes}),flush=True)
with archive.open('xb') as out:
    for j in jobs:
        with (parts/(str(j['index']).zfill(4)+'.part')).open('rb') as inp: shutil.copyfileobj(inp,out)
assert archive.stat().st_size==record['bytes']
actual=hashlib.file_digest(archive.open('rb'),'sha256').hexdigest()
assert actual==record['sha256']
result={'capturedAt':datetime.now(timezone.utc).isoformat(),'transport':'SSH raw PTY encrypted ranges','hostIdentityCheck':'existing alias, strict host key check','rangeBytes':block,'rangeCount':len(jobs),'streams':16,'rangeTimeoutSeconds':90,'automaticRetries':0,'bytes':record['bytes'],'sha256':actual,'fullHashMatches':True,'elapsedSeconds':round(time.monotonic()-started,2)}
(EV/'iris-release-c7a286f3-20261009-transfer.json').write_text(json.dumps(result,indent=2)+'\n',encoding='utf-8')
print(json.dumps(result),flush=True)
