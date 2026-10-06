"""Prepare private release files and validate configuration; do not switch running services."""
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess

ROOT = Path('/opt/iris/repository')
STAGE = ROOT / 'evidence/release-20261006-51937b95'
OLD = 'f6a6dd4187dcb1b574fb78a11f837edec8b09b89'
NEW = '51937b954733020799e02f139abd32df74b3349c'
os.umask(0o077)

def run(args, timeout=60):
    p = subprocess.run(args, cwd=ROOT, capture_output=True, text=True, timeout=timeout, stdin=subprocess.DEVNULL)
    if p.returncode:
        raise RuntimeError('release preparation command failed: ' + args[0])
    return p.stdout

def config(env, compose):
    return json.loads(run(['docker', 'compose', '--project-directory', str(ROOT / 'deploy/pilot'),
                          '--env-file', str(env), '--file', str(compose), 'config', '--format', 'json']))

assert run(['git', 'rev-parse', 'HEAD']).strip() == OLD
assert hashlib.sha256((ROOT / 'deploy/pilot/Caddyfile').read_bytes()).hexdigest() == '80ac0aceb176f0e6d1bb6827aa9692c5a2751d517e89bf9c8e3aaf88dcdd7a07'
assert hashlib.sha256((STAGE / 'core-image.tar').read_bytes()).hexdigest() == '8b374d8a665d7fd9d79b5ee328bbf511814f8a85fc0518dd0b42244283a0c2af'
run(['git', 'fetch', 'origin', 'refs/heads/codex/iris-release-51937b95'])
assert run(['git', 'rev-parse', 'FETCH_HEAD']).strip() == NEW
image = json.loads(run(['docker', 'image', 'inspect', 'iris-core:' + NEW]))[0]
assert image['Config']['Labels']['org.opencontainers.image.revision'] == NEW
assert image['Id'] == 'sha256:d1d4e7f732efbfe205bed9ece9bbce37f4531c21e5b52042c21d8029f06446f9'
assert image['Architecture'] == 'amd64' and image['Os'] == 'linux'
containers = {service: json.loads(run(['docker', 'inspect', 'iris-pilot-' + service + '-1']))[0]
              for service in ['core', 'ai-worker', 'caddy', 'postgres', 'redis', 'embedding-model']}
assert containers['core']['Config']['Image'] == 'iris-core:' + OLD
assert containers['core']['State']['Health']['Status'] == 'healthy'
old_config = config(ROOT / '.env.pilot', ROOT / 'deploy/pilot/docker-compose.yml')
for name, source in [('before.env', '.env.pilot'), ('before.compose.yml', 'deploy/pilot/docker-compose.yml')]:
    with (STAGE / name).open('xb') as target:
        target.write((ROOT / source).read_bytes())
env_text = (ROOT / '.env.pilot').read_text()
updates = {'IRIS_IMAGE_TAG': NEW, 'IRIS_RUNTIME_GLOBAL_ENABLED': 'false',
           'IRIS_PROACTIVE_DISCUSSION_ENABLED': 'false', 'IRIS_PROACTIVE_DISCUSSION_GROUP_IDS': '',
           'IRIS_PROACTIVE_DISCUSSION_OPINION_MODE': 'legacy', 'IRIS_PROACTIVE_DISCUSSION_MODEL_SOURCE': 'shared'}
for key, value in updates.items():
    pattern = r'^' + re.escape(key) + r'=.*$'
    matches = re.findall(pattern, env_text, re.M)
    assert len(matches) <= 1
    env_text = re.sub(pattern, key + '=' + value, env_text, flags=re.M) if matches else env_text.rstrip('\n') + '\n' + key + '=' + value + '\n'
compose_text = run(['git', 'show', NEW + ':deploy/pilot/docker-compose.yml'])
original = '  image: iris-ai-worker:${IRIS_IMAGE_TAG:?IRIS_IMAGE_TAG is required}'
assert compose_text.count(original) == 1
ai_image = containers['ai-worker']['Config']['Image']
assert ai_image == 'iris-ai-worker:' + OLD
compose_text = compose_text.replace(original, '  image: ' + ai_image)
with (STAGE / 'candidate.env').open('x') as target:
    target.write(env_text)
with (STAGE / 'candidate.compose.yml').open('x') as target:
    target.write(compose_text)
candidate = config(STAGE / 'candidate.env', STAGE / 'candidate.compose.yml')
old_env = dict(item.split('=', 1) for item in containers['core']['Config']['Env'])
with (STAGE / 'before-live-env.json').open('x') as target:
    json.dump(old_env, target)
baseline = {service: {'containerId': c['Id'], 'imageId': c['Image'], 'imageTag': c['Config']['Image']} for service,c in containers.items()}
with (STAGE / 'before-services.json').open('x') as target:
    json.dump(baseline, target)
new_env = candidate['services']['core']['environment']
qa_keys = ['IRIS_MODEL_PROVIDER', 'IRIS_MODEL_BASE_URL', 'IRIS_MODEL_API_KEY', 'IRIS_MODEL_NAME', 'IRIS_MODEL_TIMEOUT_MS', 'IRIS_MODEL_STRUCTURED_OUTPUT_MODE']
defaults = {'IRIS_MODEL_TIMEOUT_MS': '30000', 'IRIS_MODEL_STRUCTURED_OUTPUT_MODE': 'json_schema'}
qa_equal = all((old_env.get(key) or defaults.get(key, '')).strip() == (str(new_env.get(key) or defaults.get(key, ''))).strip() for key in qa_keys)
assert qa_equal, 'ordinary QA configuration changed'
changed = sorted(key for key in old_env.keys() | new_env.keys() if old_env.get(key) != new_env.get(key))
unexpected = [key for key in changed if key in old_config['services']['core']['environment'] and not key.startswith('IRIS_PROACTIVE_DISCUSSION_') and key != 'IRIS_MODEL_STRUCTURED_OUTPUT_MODE']
assert not unexpected, 'existing Core environment changed'
for service in ['ai-worker', 'postgres', 'redis', 'embedding-model', 'embedding-model-init', 'caddy']:
    assert candidate['services'][service] == old_config['services'][service], 'non-Core service configuration changed: ' + service
assert new_env['IRIS_PROACTIVE_DISCUSSION_ENABLED'] == 'false'
assert new_env['IRIS_PROACTIVE_DISCUSSION_GROUP_IDS'] == ''
assert candidate['services']['migrate']['image'] == 'iris-core:' + NEW
assert candidate['services']['core']['image'] == 'iris-core:' + NEW
output = {'releaseCommit': NEW, 'importedImageId': image['Id'], 'qaConfigurationEquivalent': qa_equal,
          'unchangedServiceConfigurations': ['ai-worker', 'postgres', 'redis', 'embedding-model', 'embedding-model-init', 'caddy'],
          'addedOrChangedCoreEnvironmentKeys': changed, 'aiWorkerPinnedImage': ai_image,
          'candidateComposeSha256': hashlib.sha256((STAGE / 'candidate.compose.yml').read_bytes()).hexdigest(),
          'privateFilesMode600': all((STAGE / name).stat().st_mode & 0o777 == 0o600 for name in ['before.env', 'before.compose.yml', 'candidate.env', 'candidate.compose.yml']),
          'beforeServices': baseline, 'servicesSwitched': False, 'databaseMigrated': False}
assert output['privateFilesMode600']
print(json.dumps(output, indent=2))
