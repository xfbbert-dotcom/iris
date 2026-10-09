"""Freeze retained ranges and retrieve missing ciphertext through one non-PTY connection."""
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import shlex
import subprocess
import time

EV = Path(__file__).resolve().parent
PRIVATE = Path('C:/Users/59912/AppData/Local/Iris/release-20261009-c7a286f3')
record = json.loads((EV/'iris-release-c7a286f3-20261009-backup.json').read_text(encoding='utf-8-sig'))
assert record['path'] == '/opt/iris/repository/evidence/release-20261009-c7a286f3/backups/iris-20261009T071821Z.bundle.tar.age'
assert record['bytes'] == 759491816
assert record['sha256'] == 'd5b64b5efc19da5023d3df0cb10f8a3f5af8900c2af1cdfc976b38152f96362b'
parts, tails = PRIVATE/'encrypted-parts', PRIVATE/'encrypted-tails'
stage = PRIVATE/'encrypted-stream'
stage.mkdir()
existing = []
suffix_index = 0
for index, offset in enumerate(range(0, record['bytes'], 4194304)):
    end = min(offset+4194304, record['bytes'])
    path = parts/(str(index).zfill(4)+'.part')
    size = path.stat().st_size if path.exists() else 0
    assert 0 <= size <= end-offset
    if size: existing.append({'offset': offset, 'size': size, 'path': str(path), 'sha256': hashlib.sha256(path.read_bytes()).hexdigest()})
    cursor = offset+size
    while cursor < end:
        length = min(1048576, end-cursor)
        path = tails/(str(suffix_index).zfill(4)+'.part')
        size = path.stat().st_size if path.exists() else 0
        assert 0 <= size <= length
        if size: existing.append({'offset': cursor, 'size': size, 'path': str(path), 'sha256': hashlib.sha256(path.read_bytes()).hexdigest()})
        suffix_index += 1
        cursor += length
assert suffix_index == 440
existing.sort(key=lambda x: x['offset'])
missing = []
cursor = 0
for item in existing:
    assert item['offset'] >= cursor
    if item['offset'] > cursor: missing.append({'offset': cursor, 'size': item['offset']-cursor})
    cursor = item['offset']+item['size']
if cursor < record['bytes']: missing.append({'offset': cursor, 'size': record['bytes']-cursor})
manifest = {'source': record, 'retained': existing, 'missing': missing}
(stage/'frozen-manifest.json').write_text(json.dumps(manifest, indent=2))
expected = sum(x['size'] for x in missing)
assert expected+sum(x['size'] for x in existing) == record['bytes']
remote = '''import sys,json,hashlib
m=json.load(sys.stdin)
with open(m['source']['path'],'rb') as f:
 for item in m['retained']:
  f.seek(item['offset'])
  assert hashlib.sha256(f.read(item['size'])).hexdigest()==item['sha256'], 'retained range mismatch'
 sys.stderr.write('retained-ranges-verified\\n');sys.stderr.flush()
 for item in m['missing']:
  f.seek(item['offset']);remaining=item['size']
  while remaining:
   data=f.read(min(1048576,remaining));assert data
   sys.stdout.buffer.write(data);remaining-=len(data)
 sys.stdout.buffer.flush()
sys.stderr.write('missing-ranges-complete\\n');sys.stderr.flush()
'''
SSH = ['ssh','-T','-o','BatchMode=yes','-o','HostName=43.160.229.172','-o','HostKeyAlias=iris.quello.cn','-o','StrictHostKeyChecking=yes','-o','ConnectTimeout=10','-o','ServerAliveInterval=5','-o','ServerAliveCountMax=2','-o','IPQoS=none','iris-vps']
payload = {'source': record, 'retained': [{k:v for k,v in x.items() if k!='path'} for x in existing], 'missing': missing}
stream = stage/'missing-ciphertext.bin'
started = time.monotonic()
print(json.dumps({'retainedBytes':record['bytes']-expected,'missingBytes':expected,'missingRanges':len(missing),'connections':1,'pty':False,'timeoutSeconds':900}),flush=True)
with stream.open('xb') as out, (stage/'stderr.txt').open('xb') as err:
    proc = subprocess.Popen(SSH+['python3 -c '+shlex.quote(remote)], stdin=subprocess.PIPE, stdout=out, stderr=err)
    proc.stdin.write(json.dumps(payload).encode()); proc.stdin.close()
    while proc.poll() is None:
        if time.monotonic()-started > 900:
            proc.kill();proc.wait();raise RuntimeError('single-stream timeout; ciphertext and frozen mapping retained')
        time.sleep(5)
        print(json.dumps({'elapsedSeconds':round(time.monotonic()-started),'receivedBytes':stream.stat().st_size,'expectedBytes':expected}),flush=True)
stderr = (stage/'stderr.txt').read_text()
assert proc.returncode == 0 and stream.stat().st_size == expected, 'single-stream incomplete; retained for diagnosis'
assert stderr == 'retained-ranges-verified\nmissing-ranges-complete\n', 'remote verification marker missing'
archive = PRIVATE/Path(record['path']).name
segments = sorted([dict(x,kind='retained') for x in existing]+[dict(x,kind='missing') for x in missing], key=lambda x:x['offset'])
with archive.open('xb') as out, stream.open('rb') as inp:
    cursor = 0
    for item in segments:
        assert item['offset'] == cursor
        if item['kind'] == 'retained':
            data=Path(item['path']).read_bytes()
            assert len(data)==item['size'] and hashlib.sha256(data).hexdigest()==item['sha256']
            out.write(data)
        else:
            remaining=item['size']
            while remaining:
                data=inp.read(min(1048576,remaining));assert data
                out.write(data);remaining-=len(data)
        cursor += item['size']
    assert cursor == record['bytes'] and inp.read(1)==b''
with archive.open('rb') as f: actual=hashlib.file_digest(f,'sha256').hexdigest()
assert archive.stat().st_size==record['bytes'] and actual==record['sha256']
result={'capturedAt':datetime.now(timezone.utc).isoformat(),'transport':'single persistent SSH non-PTY connection','retainedBytes':record['bytes']-expected,'allRetainedHashesVerifiedRemote':True,'missingBytes':expected,'connections':1,'automaticRetries':0,'timeoutSeconds':900,'bytes':record['bytes'],'sha256':actual,'fullHashMatches':True,'elapsedSeconds':round(time.monotonic()-started,2)}
(EV/'iris-release-c7a286f3-20261009-transfer-verified.json').write_text(json.dumps(result,indent=2)+'\n')
print(json.dumps(result),flush=True)
