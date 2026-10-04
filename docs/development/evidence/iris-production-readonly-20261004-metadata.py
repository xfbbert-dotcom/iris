# Execute via the existing SSH connection; outputs only selected non-secret metadata.
import json
import subprocess
from datetime import datetime, timezone


def run(args):
    result = subprocess.run(args, text=True, capture_output=True, timeout=25)
    if result.returncode != 0:
        raise RuntimeError("readonly command failed: " + args[0] + "; exit=" + str(result.returncode))
    return result.stdout.strip()


fmt = '\n'.join([
    '{{json .Image}}', '{{json .Config.Image}}', '{{json .State.Status}}',
    '{{json .State.Health.Status}}',
    '{{json (index .Config.Labels "com.docker.compose.project.config_files")}}',
    '{{json (index .Config.Labels "com.docker.compose.project.working_dir")}}',
    '{{json (index .Config.Labels "com.docker.compose.project.environment_file")}}',
    '{{json (index .Config.Labels "org.opencontainers.image.revision")}}',
])
meta = [json.loads(line) for line in run([
    'docker', 'inspect', '--format', fmt, 'iris-pilot-core-1'
]).splitlines()]
node = """import {existsSync} from 'node:fs';
const names=['IRIS_MODEL_PROVIDER','IRIS_MODEL_NAME','IRIS_MODEL_STRUCTURED_OUTPUT_MODE',
'IRIS_PROACTIVE_DISCUSSION_OPINION_MODE','IRIS_PROACTIVE_DISCUSSION_ENABLED',
'IRIS_PROACTIVE_DISCUSSION_GROUP_IDS','IRIS_RUNTIME_GLOBAL_ENABLED',
'IRIS_PROACTIVE_SIGNAL_PLANNER_ENABLED','IRIS_PROACTIVE_SIGNAL_DELIVERY_ENABLED'];
console.log(JSON.stringify({environment:Object.fromEntries(names.map(k=>[k,process.env[k]??null])),
sourcePlanModulePresent:existsSync('/app/apps/core/dist/proactive-discussion/opinion-mode.js')}));"""
selected = json.loads(run([
    'docker', 'exec', 'iris-pilot-core-1', 'node', '--input-type=module', '-e', node
]))
print(json.dumps({
    'capturedAt': datetime.now(timezone.utc).isoformat(),
    'repositoryHead': run(['git', '-C', '/opt/iris/repository', 'rev-parse', 'HEAD']),
    'repositoryStatus': run(['git', '-C', '/opt/iris/repository', 'status', '--short']),
    'core': dict(zip(['imageId', 'imageTag', 'state', 'health', 'composeFiles',
                      'workingDir', 'environmentFile', 'revisionLabel'], meta)),
    **selected,
}, ensure_ascii=False, indent=2))
