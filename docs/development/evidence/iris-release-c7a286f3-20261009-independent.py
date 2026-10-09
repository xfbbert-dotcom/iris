"""Independent post-release readback; run on the VPS after acceptance.

No SSH, deployment commands, file writes, model calls or Feishu sends are used.
Existing container-local GET probes may install the durable disabled snapshot in
the live controller. Public HTTP checks are performed separately by the operator.
Raw subprocess output, credentials and business data are never printed.
"""
from datetime import datetime, timezone
import json
from pathlib import Path
import re
import subprocess
import sys

ROOT = Path('/opt/iris/repository')
STAGE = ROOT / 'evidence/release-20261009-c7a286f3'
OLD = '51937b954733020799e02f139abd32df74b3349c'
NEW = 'c7a286f37a85afa5c023359135b1331fdc556e94'
IMAGE = 'sha256:19cce91342a177a68bb5cb94efb86e69c011cf54829a118f40ef990974bbea4e'
SERVICES = ('core', 'ai-worker', 'postgres', 'redis', 'embedding-model', 'caddy')
MARKERS = ('.iris-approved-commit', '.iris-candidate-commit', '.iris-source-commit')
DATABASE_FIELDS = ('migrations', 'tablePrivileges', 'sequencePrivileges', 'appRole',
                   'proseSourcesColumn', 'domainCounts', 'jobs', 'deliveries',
                   'answers', 'policies')
READY = {'checkCount': 21, 'passCount': 21, 'warnCount': 0,
         'failCount': 0, 'highestSeverity': 'pass'}


class GateFailure(Exception):
    """Only fixed, non-sensitive gate names may be used as messages."""


def require(condition, code):
    if not condition:
        raise GateFailure(code)


def run(args, code, data=None):
    options = {'input': data} if data is not None else {'stdin': subprocess.DEVNULL}
    try:
        result = subprocess.run(args, cwd=ROOT, capture_output=True,
                                timeout=60, **options)
    except (OSError, subprocess.TimeoutExpired):
        raise GateFailure(code) from None
    require(result.returncode == 0, code)
    return result.stdout


def read_json(name):
    return json.loads((STAGE / name).read_bytes())


def probe(name):
    require(name in ('status.mjs', 'readiness.mjs', 'database.mjs'), 'probe_name')
    return json.loads(run(['docker', 'exec', '-i', 'iris-pilot-core-1',
                          'node', '--input-type=module'],
                         'probe_' + name.split('.')[0], (STAGE / name).read_bytes()))


def collect():
    head = run(['git', 'rev-parse', 'HEAD'], 'source_readback').decode().strip()
    require(head == NEW, 'source_commit')
    before = {'services': read_json('before-services.json'),
              'liveEnv': read_json('before-live-env.json'),
              'env': (STAGE / 'before.env').read_bytes(),
              'compose': (STAGE / 'before.compose.yml').read_bytes(),
              'caddy': (STAGE / 'before.Caddyfile').read_bytes(),
              'status': read_json('before-status.json'),
              'readiness': read_json('before-readiness.json'),
              'database': read_json('before-database.json')}
    containers = json.loads(run(['docker', 'inspect', *[
        'iris-pilot-' + service + '-1' for service in SERVICES]], 'service_readback'))
    require(len(containers) == len(SERVICES), 'service_count')
    observed = {'head': head,
                'markers': {name: (ROOT / name).read_bytes() for name in MARKERS},
                'containers': dict(zip(SERVICES, containers)),
                'env': (ROOT / '.env.pilot').read_bytes(),
                'envMode': (ROOT / '.env.pilot').stat().st_mode & 0o777,
                'compose': (ROOT / 'deploy/pilot/docker-compose.yml').read_bytes(),
                'caddy': (ROOT / 'deploy/pilot/Caddyfile').read_bytes(),
                'status': probe('status.mjs'),
                'readiness': probe('readiness.mjs'),
                'database': probe('database.mjs')}
    return before, observed


def evaluate(before, observed):
    checks = {}

    def check(code, condition):
        require(condition, code)
        checks[code] = True

    check('sourceAndMarkersMatch', observed['head'] == NEW and
          all(observed['markers'][name] == (NEW + '\n').encode() for name in MARKERS))
    core = observed['containers']['core']
    check('exactCoreImageHealthy', core['Image'] == IMAGE and
          core['Config']['Image'] == 'iris-core:' + NEW and
          core['Config']['Labels']['org.opencontainers.image.revision'] == NEW and
          core['State']['Running'] is True and core['State']['Health']['Status'] == 'healthy')
    live_env = dict(entry.split('=', 1) for entry in core['Config']['Env'])
    check('coreEnvironmentPreserved', live_env == before['liveEnv'])
    check('deploymentGatesClosed', live_env.get('IRIS_RUNTIME_GLOBAL_ENABLED') == 'false' and
          live_env.get('IRIS_PROACTIVE_DISCUSSION_ENABLED') == 'false' and
          live_env.get('IRIS_PROACTIVE_DISCUSSION_GROUP_IDS', '') == '')
    expected_env, replacements = re.subn(rb'(?m)^IRIS_IMAGE_TAG=[^\r\n]*',
                                        ('IRIS_IMAGE_TAG=' + NEW).encode(), before['env'])
    check('onlyImageTagChangedInEnv', replacements == 1 and
          observed['env'] == expected_env and observed['envMode'] == 0o600)
    check('composeAndCaddyBytesPreserved', observed['compose'] == before['compose'] and
          observed['caddy'] == before['caddy'])
    check('nonCoreServicesPreservedAndRunning', all(
        observed['containers'][name]['Id'] == before['services'][name]['containerId'] and
        observed['containers'][name]['Image'] == before['services'][name]['imageId'] and
        observed['containers'][name]['Config']['Image'] == before['services'][name]['imageTag'] and
        observed['containers'][name]['State']['Running'] is True
        for name in SERVICES if name != 'core'))

    readiness = observed['readiness']
    check('liveReadiness21Passed', readiness['ok'] is True and readiness['status'] == 'ready' and
          readiness['summary'] == READY == before['readiness']['summary'] and
          readiness['checks'] == before['readiness']['checks'] and
          len(readiness['checks']) == 21 and all(x['status'] == 'pass' for x in readiness['checks']))
    status = observed['status']
    control = status['control']
    expected_caps = dict(before['status']['control']['capabilities'])
    expected_caps['replyWhenMentioned'] = False
    check('liveAndDurableRuntimeClosed', status['ok'] is True and
          all(control[key] is False for key in ('globalEnabled', 'desiredGlobalEnabled', 'activationRequired')) and
          control['persistence'] == {'storage': 'postgres', 'ok': True} and
          control['capabilities']['replyWhenMentioned'] is False and
          control['capabilities']['proactiveSpeech'] is False)
    check('otherCapabilitiesAndGroupsPreserved', control['capabilities'] == expected_caps and
          control['disabledGroupsFingerprint'] == before['status']['control']['disabledGroupsFingerprint'] and
          control['disabledGroupCount'] == before['status']['control']['disabledGroupCount'])
    components = status['components']
    workers = [('eventWorker', 'pendingEventCount', 'deadLetterEventCount'),
               ('documentSync', 'pendingJobCount', 'deadLetterJobCount'),
               ('reindex', 'pendingJobCount', 'deadLetterJobCount')]
    check('workersHealthyAndQueuesEmpty', all(
        all(components[name][flag] is True for flag in ('ok', 'enabled', 'running')) and
        components[name][pending] == components[name][dead] == 0
        for name, pending, dead in workers))
    check('answerRepliesSettled', all(components['eventWorker'][key] == 0 for key in (
        'answerReplyUnresolvedCount', 'answerReplyPendingSafeNoticeCount',
        'answerReplyReconciliationRequiredCount')))
    pd = components['proactiveDiscussion']
    check('proactiveDiscussionClosedAndSettled', pd['ok'] is True and
          pd['enabled'] is False and pd['running'] is False and
          all(pd[key] == 0 for key in ('pending', 'failed', 'deadLetter', 'unknown')))

    database = observed['database']
    check('databaseBaselinePreserved', database['ok'] is True and
          database['transaction'] == 'repeatable-read/read-only' and
          all(database[key] == before['database'][key] for key in DATABASE_FIELDS))
    check('migrationHistoryUnchanged', len(database['migrations']) == 53)
    check('durableQaAndProactiveClosed', all(database['runtime'][key] is False for key in (
        'desired_global_enabled', 'reply_when_mentioned', 'proactive_speech')) and
        str(database['runtime']['revision']) == str(control['revision']))
    check('allPoliciesDisabled', all(item['enabled'] is False for item in database['policies']))
    check('databaseJobsAndDeliveriesSettled',
          all(item['state'] in ('completed', 'cancelled') for item in database['jobs']) and
          all(item['state'] in ('sent', 'cancelled') for item in database['deliveries']))
    return {'capturedAt': datetime.now(timezone.utc).isoformat(),
            'kind': 'independent-closed-state-release-readback', 'ok': True,
            'applicationSha': NEW, 'coreImageId': IMAGE, 'checks': checks,
            'readinessPassed': 21, 'migrationCount': 53, 'nonCoreServicesChecked': 5,
            'policyCount': sum(item['n'] for item in database['policies']),
            'proactiveJobCount': sum(item['n'] for item in database['jobs']),
            'proactiveDeliveryCount': sum(item['n'] for item in database['deliveries']),
            'globalEnabled': False, 'desiredGlobalEnabled': False,
            'qaEnabled': False, 'proactiveDiscussionEnabled': False,
            'publicBoundaryChecked': False}


def main():
    try:
        require(len(sys.argv) == 1, 'unexpected_arguments')
        result = evaluate(*collect())
    except GateFailure as error:
        print(json.dumps({'ok': False, 'code': str(error)}))
        return 1
    except Exception:
        # Do not expose raw service/config data through an exception or traceback.
        print(json.dumps({'ok': False, 'code': 'independent_readback_unavailable'}))
        return 1
    print(json.dumps(result, indent=2))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
