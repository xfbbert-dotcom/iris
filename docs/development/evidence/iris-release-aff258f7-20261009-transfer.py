"""Copy this release's encrypted backup over one verified, non-PTY SSH connection."""
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import shlex
import subprocess
import time

EV = Path(__file__).resolve().parent
PRIVATE = Path('C:/Users/59912/AppData/Local/Iris/release-20261009-aff258f7')
record = json.loads((EV/'iris-release-aff258f7-20261009-backup.json').read_text(encoding='utf-8-sig'))
assert record['sourceCommit'] == 'c7a286f37a85afa5c023359135b1331fdc556e94'
source = Path(record['path'])
assert source.parent.as_posix() == '/opt/iris/repository/evidence/release-20261009-aff258f7/backups'
assert source.name.startswith('iris-') and source.name.endswith('.bundle.tar.age')
assert record['bytes'] > 0 and len(record['sha256']) == 64
archive = PRIVATE/source.name
assert not archive.exists()
remote = '''import sys,json,hashlib
from pathlib import Path
r=json.load(sys.stdin);p=Path(r['path'])
assert p.stat().st_size==r['bytes']
with p.open('rb') as f:assert hashlib.file_digest(f,'sha256').hexdigest()==r['sha256']
with p.open('rb') as f:
 while True:
  data=f.read(1048576)
  if not data:break
  sys.stdout.buffer.write(data)
sys.stdout.buffer.flush()
sys.stderr.write('ciphertext-complete\\n')
'''
SSH = ['ssh','-T','-o','BatchMode=yes','-o','HostName=43.160.229.172',
       '-o','HostKeyAlias=iris.quello.cn','-o','StrictHostKeyChecking=yes',
       '-o','ConnectTimeout=10','-o','ServerAliveInterval=5','-o','ServerAliveCountMax=2',
       '-o','IPQoS=none','iris-vps']
started = time.monotonic()
with archive.open('xb') as out, (PRIVATE/'backup-transfer.stderr').open('xb') as err:
    proc = subprocess.Popen(SSH+['python3 -c '+shlex.quote(remote)], stdin=subprocess.PIPE, stdout=out, stderr=err)
    proc.stdin.write(json.dumps(record).encode()); proc.stdin.close()
    while proc.poll() is None:
        if time.monotonic()-started > 900:
            proc.kill(); proc.wait()
            raise RuntimeError('backup transfer deadline; ciphertext retained, no automatic retry')
        time.sleep(10)
        print(json.dumps({'elapsedSeconds':round(time.monotonic()-started),
                          'receivedBytes':archive.stat().st_size,'expectedBytes':record['bytes']}),flush=True)
assert proc.returncode == 0, 'backup transfer failed; ciphertext retained'
assert (PRIVATE/'backup-transfer.stderr').read_bytes() == b'ciphertext-complete\n'
assert archive.stat().st_size == record['bytes'], 'backup transfer short; ciphertext retained'
with archive.open('rb') as handle: digest = hashlib.file_digest(handle,'sha256').hexdigest()
assert digest == record['sha256'], 'backup digest mismatch; ciphertext retained'
result = {'capturedAt':datetime.now(timezone.utc).isoformat(),'sourceCommit':record['sourceCommit'],
          'connections':1,'pty':False,'automaticRetries':0,'bytes':record['bytes'],
          'sha256':digest,'fullHashMatches':True,'elapsedSeconds':round(time.monotonic()-started,2)}
(EV/'iris-release-aff258f7-20261009-transfer-verified.json').write_text(json.dumps(result,indent=2)+'\n')
print(json.dumps(result),flush=True)
