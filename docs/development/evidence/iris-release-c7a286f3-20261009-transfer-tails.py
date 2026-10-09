"""Verify retained encrypted prefixes, then continue with bounded 1 MiB suffixes."""
from concurrent.futures import ThreadPoolExecutor, wait, FIRST_COMPLETED
from datetime import datetime, timezone
import hashlib
import json
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
parts=PRIVATE/'encrypted-parts'; tails=PRIVATE/'encrypted-tails'; tails.mkdir()
archive=PRIVATE/Path(record['path']).name; assert not archive.exists()
SSH=['ssh','-tt','-o','BatchMode=yes','-o','HostName=43.160.229.172','-o','HostKeyAlias=iris.quello.cn','-o','StrictHostKeyChecking=yes','-o','ConnectTimeout=10','-o','ServerAliveInterval=5','-o','ServerAliveCountMax=2','-o','IPQoS=none','iris-vps']
block=4194304; retained=[]; jobs=[]
for index,offset in enumerate(range(0,record['bytes'],block)):
    expected=min(block,record['bytes']-offset); path=parts/(str(index).zfill(4)+'.part')
    size=path.stat().st_size if path.exists() else 0; assert 0<=size<=expected
    retained.append({'part':index,'offset':offset,'expected':expected,'received':size,'sha256':hashlib.sha256(path.read_bytes()).hexdigest() if size else None})
    cursor=offset+size
    while cursor<offset+expected:
        length=min(1048576,offset+expected-cursor)
        jobs.append({'index':len(jobs),'part':index,'offset':cursor,'size':length})
        cursor+=length
remote="import json,hashlib\nitems="+repr(retained)+"\npath="+repr(record['path'])+"\nwith open(path,'rb') as f:\n for j in items:\n  if j['received']:\n   f.seek(j['offset']);assert hashlib.sha256(f.read(j['received'])).hexdigest()==j['sha256']\nprint(json.dumps({'prefixesMatch':True}))\n"
p=subprocess.run([x if x!='-tt' else '-T' for x in SSH]+['python3 -'],input=remote.encode(),capture_output=True,timeout=60)
assert p.returncode==0 and json.loads(p.stdout)['prefixesMatch'] is True
started=time.monotonic()
print(json.dumps({'verifiedRetainedBytes':sum(j['received'] for j in retained),'missingBytes':sum(j['size'] for j in jobs),'ranges':len(jobs),'streams':6}),flush=True)

def copy(job):
    target=tails/(str(job['index']).zfill(4)+'.part'); attempts=[]
    for attempt in range(3):
        if time.monotonic()-started>900: raise RuntimeError('transfer session limit reached')
        size=target.stat().st_size if target.exists() else 0
        assert 0<=size<=job['size']
        if size==job['size']: return {'bytes':size,'attempts':attempts}
        command='stty raw -echo; dd if='+shlex.quote(record['path'])+' bs=65536 iflag=skip_bytes,count_bytes skip='+str(job['offset']+size)+' count='+str(job['size']-size)+' status=none'
        with target.open('ab') as out:
            try:
                result=subprocess.run(SSH+[command],stdin=subprocess.DEVNULL,stdout=out,stderr=subprocess.PIPE,timeout=45)
                error=result.stderr; code=result.returncode
            except subprocess.TimeoutExpired as exc:
                error=exc.stderr or b''; code='timeout'
        (tails/(str(job['index']).zfill(4)+'.'+str(attempt)+'.stderr')).write_bytes(error)
        attempts.append({'attempt':attempt+1,'exitCode':code,'beforeBytes':size,'afterBytes':target.stat().st_size,'stderrSha256':hashlib.sha256(error).hexdigest()})
        if target.stat().st_size==job['size']: return {'bytes':job['size'],'attempts':attempts}
        time.sleep(attempt+1)
    (tails/(str(job['index']).zfill(4)+'.failed.json')).write_text(json.dumps(attempts))
    raise RuntimeError('encrypted suffix incomplete after bounded reconnect: '+str(job['index']))

reports=[]
with ThreadPoolExecutor(max_workers=6) as pool:
    pending={pool.submit(copy,j):j for j in jobs[:6]}; next_index=len(pending)
    while pending:
        done,_=wait(pending,timeout=20,return_when=FIRST_COMPLETED)
        for future in done:
            job=pending.pop(future); reports.append(dict(job,result=future.result()))
            if next_index<len(jobs):
                job=jobs[next_index]; pending[pool.submit(copy,job)]=job; next_index+=1
        if not done or len(reports)%24==0 or len(reports)==len(jobs):
            print(json.dumps({'elapsedSeconds':round(time.monotonic()-started),'completedRanges':len(reports),'totalRanges':len(jobs)}),flush=True)
with archive.open('xb') as out:
    for prefix in retained:
        if prefix['received']:
            with (parts/(str(prefix['part']).zfill(4)+'.part')).open('rb') as inp: shutil.copyfileobj(inp,out)
        for job in jobs:
            if job['part']==prefix['part']:
                with (tails/(str(job['index']).zfill(4)+'.part')).open('rb') as inp: shutil.copyfileobj(inp,out)
with archive.open('rb') as f: actual=hashlib.file_digest(f,'sha256').hexdigest()
assert archive.stat().st_size==record['bytes'] and actual==record['sha256']
report={'capturedAt':datetime.now(timezone.utc).isoformat(),'transport':'verified-prefix SSH raw PTY suffix continuation','verifiedRetainedBytes':sum(j['received'] for j in retained),'prefixesAllMatchRemote':True,'rangeCount':len(jobs),'rangeBytes':1048576,'streams':6,'perAttemptTimeoutSeconds':45,'maxAttemptsPerSuffix':3,'reconnections':sum(max(0,len(x['result']['attempts'])-1) for x in reports),'bytes':record['bytes'],'sha256':actual,'fullHashMatches':True,'elapsedSeconds':round(time.monotonic()-started,2)}
(PRIVATE/'suffix-attempts.json').write_text(json.dumps(reports,indent=2))
(EV/'iris-release-c7a286f3-20261009-transfer-verified.json').write_text(json.dumps(report,indent=2)+'\n',encoding='utf-8')
print(json.dumps(report),flush=True)
