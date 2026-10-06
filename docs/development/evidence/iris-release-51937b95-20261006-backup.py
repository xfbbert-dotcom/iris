"""Authorized maintenance: close ingress and take an old-version paired backup."""
import fcntl
import hashlib
import json
import os
from pathlib import Path
import subprocess
from datetime import datetime, timezone

ROOT = Path('/opt/iris/repository')
STAGE = ROOT / 'evidence/release-20261006-51937b95'
OLD = 'f6a6dd4187dcb1b574fb78a11f837edec8b09b89'
os.umask(0o077)
DC = ['docker', 'compose', '--env-file', str(ROOT / '.env.pilot'), '--file', str(ROOT / 'deploy/pilot/docker-compose.yml')]
phases = []

def run(args, label, timeout=60, env=None):
    p = subprocess.run(args, cwd=ROOT, stdin=subprocess.DEVNULL, capture_output=True, timeout=timeout, env=env)
    (STAGE / (label + '.log')).write_bytes(p.stdout + b'\n' + p.stderr)
    if p.returncode:
        raise RuntimeError(label + ' failed, exit=' + str(p.returncode) + '; private log retained')
    return p.stdout.decode()

def phase(name):
    phases.append({'phase': name, 'at': datetime.now(timezone.utc).isoformat()})
    (STAGE / 'maintenance-phases.json').write_text(json.dumps(phases, indent=2))

def node(source, label):
    return json.loads(run(['docker', 'exec', 'iris-pilot-core-1', 'node', '--input-type=module', '-e', source], label))

with (ROOT / 'backups/.backup.lock').open('a') as lock:
    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    assert run(['git', 'rev-parse', 'HEAD'], 'backup-head').strip() == OLD
    assert (ROOT / '.env.pilot').read_bytes() == (STAGE / 'before.env').read_bytes()
    assert (ROOT / 'deploy/pilot/docker-compose.yml').read_bytes() == (STAGE / 'before.compose.yml').read_bytes()
    assert hashlib.sha256((ROOT / 'deploy/pilot/Caddyfile').read_bytes()).hexdigest() == '80ac0aceb176f0e6d1bb6827aa9692c5a2751d517e89bf9c8e3aaf88dcdd7a07'
    disabled = node('''
const r = await fetch('http://127.0.0.1:3000/internal/runtime-control/global', {
  method:'POST', headers:{authorization:'Bearer '+process.env.IRIS_INTERNAL_API_TOKEN,
  'content-type':'application/json','x-iris-operator':'release-51937b95'},
  body:JSON.stringify({enabled:false}), signal:AbortSignal.timeout(10000)});
if(r.status!==200) throw Error('durable_disable_http_failed');
const b=await r.json(); if(b.globalEnabled!==false || b.durable!==true) throw Error('disable_not_durable');
console.log(JSON.stringify({httpStatus:r.status,globalEnabled:b.globalEnabled,durable:b.durable}));
''', 'durable-disable')
    phase('durable-global-disabled')
    run(DC + ['stop', 'caddy'], 'stop-ingress', 150)
    assert run(['docker', 'inspect', 'iris-pilot-caddy-1', '--format', '{{.State.Running}}'], 'closed-ingress').strip() == 'false'
    phase('caddy-stopped')
    backup_dir = STAGE / 'backups'
    assert not backup_dir.exists()
    env = dict(os.environ, IRIS_BACKUP_DIR=str(backup_dir), IRIS_BACKUP_COMMAND_TIMEOUT_SECONDS='300', IRIS_BACKUP_HTTP_TIMEOUT_MS='10000')
    run(['bash', 'deploy/pilot/backup.sh'], 'paired-backup', 1200, env)
    archives = list(backup_dir.glob('iris-*.bundle.tar.age'))
    assert len(archives) == 1
    archive = archives[0]
    assert archive.stat().st_size > 0 and archive.stat().st_mode & 0o777 == 0o600
    with archive.open('rb') as f:
        assert f.read(22) == b'age-encryption.org/v1\n'
    assert run(['docker', 'inspect', 'iris-pilot-core-1', '--format', '{{.Config.Image}} {{.State.Health.Status}}'], 'backup-core').strip() == 'iris-core:' + OLD + ' healthy'
    assert run(['docker', 'inspect', 'iris-pilot-caddy-1', '--format', '{{.State.Running}}'], 'backup-ingress').strip() == 'false'
    phase('paired-backup-complete-ingress-closed')
    report = {'capturedAt': datetime.now(timezone.utc).isoformat(), 'sourceCommit': OLD,
              'path': str(archive), 'bytes': archive.stat().st_size,
              'sha256': hashlib.sha256(archive.read_bytes()).hexdigest(), 'mode': '0600',
              'durableDisable': disabled, 'defaultAndDedicatedBackupLocks': True,
              'coreHealthyOldVersion': True, 'caddyRunning': False, 'phases': phases,
              'offHostDecryptionVerified': False}
    (STAGE / 'backup-result.json').write_text(json.dumps(report, indent=2))
    print(json.dumps(report, indent=2))
