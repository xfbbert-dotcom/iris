"""Run on the operator machine; never transfer the existing age identity."""
import hashlib
import json
from pathlib import Path
import subprocess
import tarfile
from datetime import datetime, timezone

EV = Path(__file__).resolve().parent
PRIVATE = Path.home() / 'AppData/Local/Iris/release-20261006-51937b95'
record = json.loads((EV / 'iris-release-51937b95-20261006-backup.json').read_text())
archive = PRIVATE / Path(record['path']).name
plain = PRIVATE / 'backup.bundle.tar'
expanded = PRIVATE / 'backup-verify'
assert not plain.exists() and not expanded.exists()

def run(args, label, timeout=120):
    p = subprocess.run(args, capture_output=True, timeout=timeout, stdin=subprocess.DEVNULL)
    if p.returncode:
        raise RuntimeError(label + ' failed, exit=' + str(p.returncode))
    return p.stdout

if not archive.exists():
    run(['scp', '-q', 'iris-vps:' + record['path'], str(archive)], 'off-host copy')
assert archive.stat().st_size == record['bytes']
assert hashlib.sha256(archive.read_bytes()).hexdigest() == record['sha256']
run(['age', '--decrypt', '--identity', str(Path.home() / '.config/age/iris-backup-key.txt'),
     '--output', str(plain), str(archive)], 'existing identity decryption')
expanded.mkdir()
with tarfile.open(plain) as bundle:
    members = bundle.getmembers()
    assert sorted(m.name for m in members) == ['manifest.txt', 'postgres.dump', 'redis.rdb']
    assert all(m.isfile() and m.size > 0 for m in members)
    for member in members:
        with (expanded / member.name).open('xb') as out:
            out.write(bundle.extractfile(member).read())
manifest = dict(line.split('=', 1) for line in (expanded / 'manifest.txt').read_text().splitlines())
assert manifest['format'] == 'iris-pilot-paired-v1'
assert manifest['runtime_global_enabled'] == manifest['runtime_desired_global_enabled'] == 'false'
assert manifest['runtime_persistence_storage'] == 'postgres' and manifest['runtime_persistence_ok'] == 'true'
mount = 'type=bind,source=' + str(expanded.resolve()) + ',target=/verify,readonly'
base = ['docker', 'run', '--rm', '--pull', 'never', '--network', 'none', '--read-only', '--mount', mount]
pg = run(base + ['--entrypoint', 'pg_restore',
    'pgvector/pgvector:pg16@sha256:1d533553fefe4f12e5d80c7b80622ba0c382abb5758856f52983d8789179f0fb',
    '--list', '/verify/postgres.dump'], 'PG dump directory validation')
rdb = run(base + ['--entrypoint', 'redis-check-rdb',
    'redis:7-alpine@sha256:6ab0b6e7381779332f97b8ca76193e45b0756f38d4c0dcda72dbb3c32061ab99',
    '/verify/redis.rdb'], 'Redis RDB validation')
report = {'capturedAt': datetime.now(timezone.utc).isoformat(), 'sourceCommit': record['sourceCommit'],
    'encryptedArchiveBytes': archive.stat().st_size, 'encryptedArchiveSha256': record['sha256'],
    'offHostCopyHashMatches': True, 'existingIdentityDecryption': True, 'identityTransferred': False,
    'manifest': manifest, 'pgRestoreListPassed': True, 'redisCheckRdbPassed': True,
    'payloads': {name: {'bytes': (expanded / name).stat().st_size,
                 'sha256': hashlib.sha256((expanded / name).read_bytes()).hexdigest()}
                 for name in ['postgres.dump', 'redis.rdb']},
    'inspectionOutputHashes': {'pg': hashlib.sha256(pg).hexdigest(), 'redis': hashlib.sha256(rdb).hexdigest()},
    'productionDatabaseRestored': False}
# Remove only the known derived plaintext files inside this exact private directory.
for target in [plain, *(expanded / name for name in ['manifest.txt', 'postgres.dump', 'redis.rdb'])]:
    assert target.resolve().is_relative_to(PRIVATE.resolve()) and target.is_file()
    target.unlink()
report['derivedPlaintextRemoved'] = True
(EV / 'iris-release-51937b95-20261006-backup-verified.json').write_text(json.dumps(report, indent=2) + '\n')
print(json.dumps(report, indent=2))
