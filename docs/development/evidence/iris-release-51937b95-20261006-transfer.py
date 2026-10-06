"""One bounded parallel transfer of the encrypted backup, with full hash verification."""
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
archive=PRIVATE/Path(record['path']).name
failed=PRIVATE/(archive.name+'.partial-sftp-120s')
assert archive.resolve().is_relative_to(PRIVATE.resolve())
assert archive.is_file() and archive.stat().st_size==2818048 and not failed.exists()
archive.rename(failed)
parts=PRIVATE/'encrypted-parts'
assert not parts.exists()
parts.mkdir()
block=1048576
blocks=math.ceil(record['bytes']/block)
streams=24
per=math.ceil(blocks/streams)
start=time.monotonic()

def copy_part(i):
    time.sleep(i*0.5)  # Bound simultaneous SSH authentication startups.
    offset=i*per
    count=min(per,blocks-offset)
    expected=min(count*block,record['bytes']-offset*block)
    path=parts/f'{i:02d}.part'
    command=f"stty raw -echo; dd if={record['path']} bs={block} skip={offset} count={count} status=none"
    with path.open('xb') as out:
        result=subprocess.run(['ssh','-tt','-o','BatchMode=yes','-o','ConnectTimeout=15',
            '-o','IPQoS=none','iris-vps',command],stdin=subprocess.DEVNULL,stdout=out,
            stderr=subprocess.PIPE,timeout=900)
    if result.returncode or path.stat().st_size!=expected:
        raise RuntimeError(f'encrypted part {i} failed or had an unexpected size')
    return {'part':i,'bytes':expected}

with ThreadPoolExecutor(max_workers=streams) as executor:
    futures=[executor.submit(copy_part,i) for i in range(streams)]
    while not all(f.done() for f in futures):
        time.sleep(30)
        print(json.dumps({'elapsedSeconds':round(time.monotonic()-start),
            'completedParts':sum(f.done() and f.exception() is None for f in futures),
            'failedParts':sum(f.done() and f.exception() is not None for f in futures),
            'observedBytes':sum(p.stat().st_size for p in parts.glob('*.part'))}),flush=True)
    results=[f.result() for f in futures]
with archive.open('xb') as out:
    for i in range(streams):
        with (parts/f'{i:02d}.part').open('rb') as inp:
            shutil.copyfileobj(inp,out)
assert archive.stat().st_size==record['bytes']
digest=hashlib.sha256(archive.read_bytes()).hexdigest()
assert digest==record['sha256']
report={'capturedAt':datetime.now(timezone.utc).isoformat(),'transport':'SSH raw PTY encrypted chunks',
    'streams':streams,'perStreamDeadlineSeconds':900,'automaticRetries':0,
    'encryptedArchiveBytes':archive.stat().st_size,'sha256':digest,'fullHashMatches':True,
    'elapsedSeconds':round(time.monotonic()-start,2),'partialSftpAttemptRetained':True}
(EV/'iris-release-51937b95-20261006-transfer.json').write_text(json.dumps(report,indent=2)+'\n')
print(json.dumps(report),flush=True)
