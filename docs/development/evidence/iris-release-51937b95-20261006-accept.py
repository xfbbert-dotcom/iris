"""Verify the new live Core, then reopen only the existing ingress container."""
import fcntl
import hashlib
import json
import os
from pathlib import Path
import subprocess
from datetime import datetime, timezone

ROOT=Path('/opt/iris/repository')
STAGE=ROOT/'evidence/release-20261006-51937b95'
NEW='51937b954733020799e02f139abd32df74b3349c'
os.umask(0o077)
DC=['docker','compose','--env-file',str(ROOT/'.env.pilot'),'--file',str(ROOT/'deploy/pilot/docker-compose.yml')]

def run(args,label,timeout=60,input_bytes=None):
    options={'input':input_bytes} if input_bytes is not None else {'stdin':subprocess.DEVNULL}
    p=subprocess.run(args,cwd=ROOT,capture_output=True,timeout=timeout,**options)
    (STAGE/(label+'.log')).write_bytes(p.stdout+b'\n'+p.stderr)
    if p.returncode: raise RuntimeError(label+' failed; private log retained')
    return p.stdout.decode()

def inspect(service):
    return json.loads(run(['docker','inspect','iris-pilot-'+service+'-1'],'accept-inspect-'+service))[0]

def probe(filename,label):
    return json.loads(run(['docker','exec','-i','iris-pilot-core-1','node','--input-type=module'],
        label,input_bytes=(STAGE/filename).read_bytes()))

def verify_status(status,before):
    assert status['ok'] is True
    c=status['control']
    assert c['globalEnabled'] is False and c['desiredGlobalEnabled'] is False and c['activationRequired'] is False
    assert c['persistence']=={'storage':'postgres','ok':True}
    assert c['capabilities']==before['control']['capabilities'] and c['capabilities']['proactiveSpeech'] is False
    assert c['disabledGroupsFingerprint']==before['control']['disabledGroupsFingerprint']
    for name,pending,dead in [('eventWorker','pendingEventCount','deadLetterEventCount'),
                            ('documentSync','pendingJobCount','deadLetterJobCount'),('reindex','pendingJobCount','deadLetterJobCount')]:
        w=status['components'][name]
        assert w['ok'] is True and w['enabled'] is True and w['running'] is True
        assert w[pending]==w[dead]==0
    assert status['components']['proactiveDiscussion']['enabled'] is False

with (ROOT/'backups/.backup.lock').open('a') as lock:
    fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
    before=json.loads((STAGE/'before-status.json').read_text())
    baseline=json.loads((STAGE/'before-services.json').read_text())
    old_env=json.loads((STAGE/'before-live-env.json').read_text())
    assert run(['git','rev-parse','HEAD'],'accept-head').strip()==NEW
    core=inspect('core')
    assert core['Image']=='sha256:d1d4e7f732efbfe205bed9ece9bbce37f4531c21e5b52042c21d8029f06446f9'
    assert core['Config']['Labels']['org.opencontainers.image.revision']==NEW
    assert core['State']['Health']['Status']=='healthy'
    env=dict(x.split('=',1) for x in core['Config']['Env'])
    defaults={'IRIS_MODEL_TIMEOUT_MS':'30000','IRIS_MODEL_STRUCTURED_OUTPUT_MODE':'json_schema'}
    qa_keys=['IRIS_MODEL_PROVIDER','IRIS_MODEL_BASE_URL','IRIS_MODEL_API_KEY','IRIS_MODEL_NAME','IRIS_MODEL_TIMEOUT_MS','IRIS_MODEL_STRUCTURED_OUTPUT_MODE']
    assert all((old_env.get(k) or defaults.get(k,'')).strip()==(env.get(k) or defaults.get(k,'')).strip() for k in qa_keys)
    assert env['IRIS_RUNTIME_GLOBAL_ENABLED']=='false' and env['IRIS_PROACTIVE_DISCUSSION_ENABLED']=='false'
    assert env['IRIS_PROACTIVE_DISCUSSION_GROUP_IDS']==''
    assert env['IRIS_PROACTIVE_DISCUSSION_OPINION_MODE']=='legacy' and env['IRIS_PROACTIVE_DISCUSSION_MODEL_SOURCE']=='shared'
    unchanged={}
    for service in ['ai-worker','postgres','redis','embedding-model','caddy']:
        c=inspect(service)
        assert c['Id']==baseline[service]['containerId'] and c['Image']==baseline[service]['imageId']
        assert c['State']['Running'] is (service!='caddy')
        unchanged[service]={'containerId':c['Id'],'imageId':c['Image']}
    assert hashlib.sha256((ROOT/'deploy/pilot/Caddyfile').read_bytes()).hexdigest()=='80ac0aceb176f0e6d1bb6827aa9692c5a2751d517e89bf9c8e3aaf88dcdd7a07'
    assert (ROOT/'.env.pilot').read_bytes()==(STAGE/'candidate.env').read_bytes()
    assert (ROOT/'deploy/pilot/docker-compose.yml').read_bytes()==(STAGE/'candidate.compose.yml').read_bytes()
    readiness=probe('readiness.mjs','new-live-readiness')
    assert readiness['summary']=={'checkCount':21,'passCount':21,'warnCount':0,'failCount':0,'highestSeverity':'pass'}
    status=probe('status.mjs','new-live-status')
    verify_status(status,before)
    database=probe('database.mjs','new-live-database')
    previous=json.loads((STAGE/'before-database.json').read_text())
    assert database['ok'] is True and database['migrations'][:-2]==previous['migrations']
    (STAGE/'new-database.json').write_text(json.dumps(database,indent=2))
    # Only after all private gates pass may the existing ingress be started.
    try:
        run(DC+['start','caddy'],'reopen-existing-ingress',150)
        caddy=inspect('caddy')
        assert caddy['Id']==baseline['caddy']['containerId'] and caddy['State']['Running'] is True
        caddy_env=dict(x.split('=',1) for x in caddy['Config']['Env'])
        hostname=caddy_env['IRIS_PUBLIC_HOSTNAME'].strip()
        origin=hostname if hostname.startswith(('https://','http://')) else 'https://'+hostname
        public={}
        for path,expected in [('/health',200),('/internal/status',404),('/internal/runtime-control/status',404)]:
            code=run(['curl','--silent','--show-error','--output','/dev/null','--write-out','%{http_code}',
                '--connect-timeout','5','--max-time','10','--retry','10','--retry-delay','1',
                '--retry-max-time','30','--retry-connrefused',origin.rstrip('/')+path], 'public-'+path.replace('/','_'),45)
            public[path]=int(code)
            assert int(code)==expected
        final_status=probe('status.mjs','final-live-status')
        verify_status(final_status,before)
        final_readiness=probe('readiness.mjs','final-live-readiness')
        assert final_readiness['summary']==readiness['summary']
        report={'capturedAt':datetime.now(timezone.utc).isoformat(),'sourceCommit':NEW,'coreImageId':core['Image'],
            'coreContainerId':core['Id'],'coreHealthy':True,'qaConfigurationEquivalent':True,
            'unchangedNonCoreServices':unchanged,'caddyfilePreserved':True,'candidateConfigurationMatches':True,
            'envMode':oct((ROOT/'.env.pilot').stat().st_mode&0o777),'publicHttp':public,
            'status':final_status,'readiness':final_readiness,'newDatabaseGatePassed':True,
            'feishuTestMessagesSent':0,'newModelRequests':0,'proactiveDiscussionEnabled':False}
        for name in ['.iris-approved-commit','.iris-candidate-commit','.iris-source-commit']:
            path=ROOT/name
            if path.exists(): (STAGE/(name+'.before')).write_bytes(path.read_bytes())
            path.write_text(NEW+'\n')
        (STAGE/'acceptance-result.json').write_text(json.dumps(report,indent=2))
        print(json.dumps(report,indent=2))
    except Exception:
        run(DC+['stop','caddy'],'reclose-on-acceptance-failure',150)
        assert inspect('caddy')['State']['Running'] is False
        raise
