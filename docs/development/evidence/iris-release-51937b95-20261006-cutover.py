"""Apply only the approved Core release after verified old-version paired backup."""
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
NEW = '51937b954733020799e02f139abd32df74b3349c'
IMAGE = 'sha256:d1d4e7f732efbfe205bed9ece9bbce37f4531c21e5b52042c21d8029f06446f9'
os.umask(0o077)
DC = ['docker', 'compose', '--env-file', str(ROOT / '.env.pilot'), '--file', str(ROOT / 'deploy/pilot/docker-compose.yml')]
phases = []

def run(args, label, timeout=60):
    p = subprocess.run(args, cwd=ROOT, stdin=subprocess.DEVNULL, capture_output=True, timeout=timeout)
    (STAGE / (label + '.log')).write_bytes(p.stdout + b'\n' + p.stderr)
    if p.returncode:
        raise RuntimeError(label + ' failed, exit=' + str(p.returncode) + '; private log retained, keep ingress closed')
    return p.stdout.decode()

def phase(name):
    phases.append({'phase': name, 'at': datetime.now(timezone.utc).isoformat()})
    (STAGE / 'cutover-phases.json').write_text(json.dumps(phases, indent=2))

def inspect(service):
    return json.loads(run(['docker', 'inspect', 'iris-pilot-' + service + '-1'], 'inspect-' + service))[0]

with (ROOT / 'backups/.backup.lock').open('a') as lock:
    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    backup = json.loads((STAGE / 'backup-result.json').read_text())
    verified = json.loads((STAGE / 'backup-verified.json').read_text())
    assert backup['sourceCommit'] == verified['sourceCommit'] == OLD
    assert backup['sha256'] == verified['encryptedArchiveSha256']
    assert hashlib.sha256(Path(backup['path']).read_bytes()).hexdigest() == backup['sha256']
    assert all(verified[k] is True for k in ['offHostCopyHashMatches', 'existingIdentityDecryption', 'pgRestoreListPassed', 'redisCheckRdbPassed'])
    assert run(['git', 'rev-parse', 'HEAD'], 'cutover-head').strip() == OLD
    assert run(['git', 'diff', '--name-only'], 'cutover-diff').strip() == 'deploy/pilot/Caddyfile'
    assert run(['git', 'rev-parse', OLD + ':deploy/pilot/Caddyfile'], 'old-caddy-blob') == run(['git', 'rev-parse', NEW + ':deploy/pilot/Caddyfile'], 'new-caddy-blob')
    assert (ROOT / '.env.pilot').read_bytes() == (STAGE / 'before.env').read_bytes()
    assert (ROOT / 'deploy/pilot/docker-compose.yml').read_bytes() == (STAGE / 'before.compose.yml').read_bytes()
    assert hashlib.sha256((ROOT / 'deploy/pilot/Caddyfile').read_bytes()).hexdigest() == '80ac0aceb176f0e6d1bb6827aa9692c5a2751d517e89bf9c8e3aaf88dcdd7a07'
    assert inspect('caddy')['State']['Running'] is False
    old_core = inspect('core')
    assert old_core['Config']['Image'] == 'iris-core:' + OLD and old_core['State']['Health']['Status'] == 'healthy'
    status = json.loads(run(['docker', 'exec', 'iris-pilot-core-1', 'node', '--input-type=module', '-e', '''
const r=await fetch('http://127.0.0.1:3000/internal/runtime-control/status', {headers:{authorization:'Bearer '+process.env.IRIS_INTERNAL_API_TOKEN},signal:AbortSignal.timeout(10000)});
if(r.status!==200) throw Error('status_failed'); const b=await r.json();
console.log(JSON.stringify({live:b.globalEnabled,desired:b.desiredGlobalEnabled,activation:b.activationRequired,persistence:b.persistence}));
'''], 'cutover-disabled-status'))
    assert status['live'] is False and status['desired'] is False and status['activation'] is False
    assert status['persistence']['storage'] == 'postgres' and status['persistence']['ok'] is True
    run(DC + ['stop', 'core'], 'stop-old-core', 150)
    phase('old-core-stopped')
    run(['git', 'checkout', '--detach', NEW], 'checkout-approved-source')
    # Atomic replacement, with the prior files already retained in the private stage.
    for candidate, destination in [('candidate.env', '.env.pilot'), ('candidate.compose.yml', 'deploy/pilot/docker-compose.yml')]:
        dest = ROOT / destination
        temp = dest.with_name(dest.name + '.release-51937b95')
        with temp.open('xb') as f:
            f.write((STAGE / candidate).read_bytes())
        os.chmod(temp, 0o600 if candidate.endswith('.env') else 0o644)
        os.replace(temp, dest)
    run(DC + ['config', '--quiet'], 'new-compose-valid')
    phase('new-source-and-config-installed')
    migration = json.loads(run(DC + ['run', '--rm', '--no-deps', '--pull', 'never', 'migrate'], 'apply-migrations', 300))
    assert migration['applied'] == ['0059_proactive_discussion.sql', '0060_proactive_discussion_prose_sources.sql']
    assert len(migration['skipped']) == 51
    phase('migrations-0059-0060-complete')
    run(DC + ['up', '--detach', '--no-deps', '--no-build', '--pull', 'never', '--force-recreate', '--wait', '--wait-timeout', '120', 'core'], 'start-new-core', 180)
    new_core = inspect('core')
    assert new_core['Image'] == IMAGE and new_core['Config']['Image'] == 'iris-core:' + NEW
    assert new_core['State']['Health']['Status'] == 'healthy'
    assert new_core['Config']['Labels']['org.opencontainers.image.revision'] == NEW
    assert inspect('caddy')['State']['Running'] is False
    phase('new-core-healthy-ingress-closed')
    report = {'capturedAt': datetime.now(timezone.utc).isoformat(), 'sourceCommit': NEW,
              'imageId': IMAGE, 'coreContainerId': new_core['Id'], 'migration': migration,
              'phases': phases, 'caddyRunning': False, 'finalLiveAcceptancePending': True}
    (STAGE / 'cutover-result.json').write_text(json.dumps(report, indent=2))
    print(json.dumps(report, indent=2))
