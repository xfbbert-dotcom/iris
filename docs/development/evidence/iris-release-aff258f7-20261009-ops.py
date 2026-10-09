"""Authorized closed-state Core release; secrets and raw service config remain in private stage."""
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
from datetime import datetime, timezone

ROOT=Path('/opt/iris/repository')
STAGE=ROOT/'evidence/release-20261009-aff258f7'
OLD='c7a286f37a85afa5c023359135b1331fdc556e94'
NEW='aff258f7fa0a1560cdbe51d305bf97bb88c5a0b5'
IMAGE='sha256:9be24803b0a63b12b29dd2fe158f0c7e3506b803ba013b25db7335fc24866f6c'
ARCHIVE_SHA='148e6eafaadb0349b1ab924373c44605265126008f35c63b562542affdce24db'
SERVICES=['core','ai-worker','postgres','redis','embedding-model','caddy']
MARKERS=['.iris-approved-commit','.iris-candidate-commit','.iris-source-commit']
DC=['docker','compose','--env-file',str(ROOT/'.env.pilot'),'--file',str(ROOT/'deploy/pilot/docker-compose.yml')]
os.umask(0o077)

QA_ENV = ('IRIS_ANSWER_ALLOWED_GROUP_IDS', 'IRIS_MODEL_MAX_TOKENS', 'IRIS_MODEL_ENABLE_THINKING')
COMPOSE_PATH = 'deploy/pilot/docker-compose.yml'

def candidate_compose(before):
    """Preserve all observed bytes, adding exactly the approved three empty-default keys."""
    lines = before.splitlines(keepends=True)
    assert all(not re.search(rb'(?m)^\s*'+key.encode()+rb'\s*:', before) for key in QA_ENV)
    additions = {
        b'  IRIS_RUNTIME_GLOBAL_ENABLED:': [QA_ENV[0]],
        b'  IRIS_MODEL_STRUCTURED_OUTPUT_MODE:': [QA_ENV[1], QA_ENV[2]],
    }
    for anchor, keys in additions.items():
        indexes = [i for i, line in enumerate(lines) if line.startswith(anchor)]
        assert len(indexes) == 1, 'approved Compose anchor missing or duplicated'
        index = indexes[0]
        ending = b'\r\n' if lines[index].endswith(b'\r\n') else b'\n'
        assert lines[index].endswith(b'\n')
        lines[index+1:index+1] = [b'  '+key.encode()+b': ${'+key.encode()+b':-}'+ending for key in keys]
    return b''.join(lines)

def expected_live_env(before):
    assert all(before.get(key, '') == '' for key in QA_ENV), 'new QA controls must remain empty'
    return {**before, **dict.fromkeys(QA_ENV, '')}

def verify_candidate_config(before, candidate):
    expected = json.loads(json.dumps(before))
    for service in ('core', 'migrate', 'embedding-model-verify'):
        expected['services'][service]['image'] = 'iris-core:'+NEW
    expected['services']['core']['environment'] = expected_live_env(before['services']['core']['environment'])
    if 'x-core-image' in expected:
        expected['x-core-image']['image'] = 'iris-core:'+NEW
    if 'x-core-environment' in expected:
        expected['x-core-environment'] = expected_live_env(before['x-core-environment'])
    assert candidate == expected, 'candidate config exceeds image and three-empty-key scope'

def verify_source_delta(label):
    for path in ('apps/core/migrations', 'workers/ai', 'package-lock.json'):
        assert not run(['git','diff',OLD,NEW,'--',path],label+'-'+path.replace('/','_')).strip()
    changed = run(['git','diff','--name-only',OLD,NEW,'--','deploy/pilot'],label+'-deploy-paths').splitlines()
    assert changed == [COMPOSE_PATH]
    old_bytes = run(['git','show',OLD+':'+COMPOSE_PATH],label+'-old-compose').encode()
    new_bytes = run(['git','show',NEW+':'+COMPOSE_PATH],label+'-new-compose').encode()
    assert new_bytes == candidate_compose(old_bytes), 'unapproved tracked Compose change'

def write_compose(data, label):
    target = ROOT/COMPOSE_PATH
    temp = target.with_name(target.name+'.aff258f7-'+label)
    assert not temp.exists()
    mode = target.stat().st_mode & 0o777
    with temp.open('xb') as handle: handle.write(data)
    os.chmod(temp, mode)
    os.replace(temp, target)

def switch_source(target, final_compose, label):
    """Only remove this captured Compose overlay while Git changes its tracked base."""
    head = run(['git','rev-parse','HEAD'],label+'-head').strip()
    assert head in (OLD, NEW)
    assert not run(['git','diff','--cached','--name-only'],label+'-staged').strip()
    changed = set(run(['git','diff','--name-only'],label+'-tracked').splitlines())
    assert changed <= {COMPOSE_PATH, 'deploy/pilot/Caddyfile'}
    assert (ROOT/'deploy/pilot/Caddyfile').read_bytes() == (STAGE/'before.Caddyfile').read_bytes()
    tracked = run(['git','show',head+':'+COMPOSE_PATH],label+'-tracked-compose').encode()
    actual = (ROOT/COMPOSE_PATH).read_bytes()
    assert actual in ((STAGE/'before.compose.yml').read_bytes(), (STAGE/'candidate.compose.yml').read_bytes(), tracked)
    # Caddy and every other path are untouched. A checkout failure remains closed and rollbackable.
    write_compose(tracked, label+'-tracked')
    run(['git','checkout','--detach',target],label+'-checkout')
    write_compose(final_compose, label+'-overlay')
    assert run(['git','rev-parse','HEAD'],label+'-final-head').strip() == target
    assert (ROOT/COMPOSE_PATH).read_bytes() == final_compose

def run(args,label,timeout=60,data=None,env=None):
    options={'input':data} if data is not None else {'stdin':subprocess.DEVNULL}
    p=subprocess.run(args,cwd=ROOT,capture_output=True,timeout=timeout,env=env,**options)
    (STAGE/(label+'.log')).write_bytes(p.stdout+b'\n'+p.stderr)
    if p.returncode: raise RuntimeError(label+' failed; private log retained')
    return p.stdout.decode()

def save(name,value):
    (STAGE/name).write_text(json.dumps(value,indent=2)+'\n')
    return value

def load(name): return json.loads((STAGE/name).read_text())
def sha(path): return hashlib.sha256(path.read_bytes()).hexdigest()
def preserve_markers():
    path=STAGE/'before-markers.json'
    if not path.exists():
        snapshot={name:{'existed':(ROOT/name).exists(),'hex':(ROOT/name).read_bytes().hex() if (ROOT/name).exists() else None} for name in MARKERS}
        with path.open('x') as f: json.dump(snapshot,f)
    return load('before-markers.json')

def restore_markers():
    snapshot=load('before-markers.json')
    assert set(snapshot)==set(MARKERS)
    for name,value in snapshot.items():
        target=ROOT/name
        if value['existed']:
            temp=ROOT/(name+'.rollback-aff258f7'); assert not temp.exists()
            with temp.open('xb') as f: f.write(bytes.fromhex(value['hex']))
            os.replace(temp,target)
        elif target.exists():
            assert target.read_bytes()==(NEW+'\n').encode()
            target.unlink()
def inspect(service): return json.loads(run(['docker','inspect','iris-pilot-'+service+'-1'],'inspect-'+service))[0]
def probe(name,label):
    return json.loads(run(['docker','exec','-i','iris-pilot-core-1','node','--input-type=module'],label,data=(STAGE/name).read_bytes()))
def node(source,label):
    return json.loads(run(['docker','exec','-i','iris-pilot-core-1','node','--input-type=module'],label,data=source.encode()))
def config(env,compose):
    return json.loads(run(['docker','compose','--project-directory',str(ROOT/'deploy/pilot'),'--env-file',str(env),'--file',str(compose),'config','--format','json'],'config-'+env.name))
def status_gate(s,require_qa_off=False):
    assert s['ok'] is True
    c=s['control']
    assert c['globalEnabled'] is False and c['desiredGlobalEnabled'] is False and c['activationRequired'] is False
    assert c['persistence']=={'storage':'postgres','ok':True}
    assert c['capabilities']['proactiveSpeech'] is False
    if require_qa_off: assert c['capabilities']['replyWhenMentioned'] is False
    for name,pending,dead in [('eventWorker','pendingEventCount','deadLetterEventCount'),('documentSync','pendingJobCount','deadLetterJobCount'),('reindex','pendingJobCount','deadLetterJobCount')]:
        v=s['components'][name]
        assert v['ok'] is True and v['enabled'] is True and v['running'] is True
        assert v[pending]==v[dead]==0
    pd=s['components']['proactiveDiscussion']
    assert pd['enabled'] is False and pd['running'] is False and pd['unknown']==0

def preflight():
    assert not (STAGE/'before-services.json').exists()
    assert run(['git','rev-parse','HEAD'],'before-head').strip()==OLD
    assert not run(['git','diff','--cached','--name-only'],'before-staged-diff').strip()
    tracked=run(['git','diff','--name-only'],'before-tracked-diff').splitlines()
    assert set(tracked)=={'deploy/pilot/Caddyfile','deploy/pilot/docker-compose.yml'}
    containers={s:inspect(s) for s in SERVICES}
    core=containers['core']
    assert core['Config']['Image']=='iris-core:'+OLD and core['State']['Health']['Status']=='healthy'
    for s in SERVICES: assert containers[s]['State']['Running'] is True
    env=dict(v.split('=',1) for v in core['Config']['Env'])
    expected_live_env(env)
    assert env.get('IRIS_PROACTIVE_DISCUSSION_ENABLED','false')=='false'
    assert env.get('IRIS_PROACTIVE_DISCUSSION_GROUP_IDS','')==''
    status=probe('status.mjs','before-status'); status_gate(status)
    ready=probe('readiness.mjs','before-readiness'); assert ready['ok'] is True
    database=probe('database.mjs','before-database')
    for name,source in [('before.env','.env.pilot'),('before.compose.yml','deploy/pilot/docker-compose.yml'),('before.Caddyfile','deploy/pilot/Caddyfile')]:
        with (STAGE/name).open('xb') as f: f.write((ROOT/source).read_bytes())
    baseline={s:{'containerId':c['Id'],'imageId':c['Image'],'imageTag':c['Config']['Image']} for s,c in containers.items()}
    save('before-services.json',baseline); save('before-live-env.json',env)
    save('before-status.json',status); save('before-readiness.json',ready); save('before-database.json',database)
    save('before-config.json',config(ROOT/'.env.pilot',ROOT/'deploy/pilot/docker-compose.yml'))
    return save('preflight-result.json',{'capturedAt':datetime.now(timezone.utc).isoformat(),'sourceCommit':OLD,'coreImage':core['Image'],'coreHealthy':True,'status':status,'readiness':ready,'database':database,'caddyfileSha256':sha(STAGE/'before.Caddyfile'),'configurationPreservedPrivately':True})

def prepare():
    assert sha(STAGE/'core-image.tar')==ARCHIVE_SHA
    preserve_markers()
    before=load('before-config.json'); baseline=load('before-services.json')
    assert run(['git','rev-parse','HEAD'],'prepare-head').strip()==OLD
    # Fetch only the already-pushed branch, then select the independently accepted application commit.
    run(['git','fetch','origin','refs/heads/codex/iris-daily-pilot-followup'],'fetch-approved-history',180)
    run(['git','merge-base','--is-ancestor',NEW,'FETCH_HEAD'],'candidate-in-fetched-history')
    verify_source_delta('approved-source-delta')
    run(['docker','load','--input',str(STAGE/'core-image.tar')],'load-image',180)
    image=json.loads(run(['docker','image','inspect','iris-core:aff258f7-local-20261009'],'loaded-image'))[0]
    expected=load('expected-image.json')
    assert image['Id']==IMAGE==expected['imageId']
    assert image['Config']==expected['config'] and image['RootFS']==expected['rootFS']
    assert image['Config']['Labels']['org.opencontainers.image.revision']==NEW
    assert image['Architecture']=='amd64' and image['Os']=='linux'
    run(['docker','tag',image['Id'],'iris-core:'+NEW],'tag-approved-image')
    env_text=(STAGE/'before.env').read_text()
    pattern=r'^IRIS_IMAGE_TAG=.*$'; assert len(re.findall(pattern,env_text,re.M))==1
    env_text=re.sub(pattern,'IRIS_IMAGE_TAG='+NEW,env_text,flags=re.M)
    for name,data in [('candidate.env',env_text.encode()),('candidate.compose.yml',candidate_compose((STAGE/'before.compose.yml').read_bytes()))]:
        path=STAGE/name
        if path.exists(): assert path.read_bytes()==data,'candidate changed between preparation attempts'
        else:
            with path.open('xb') as f: f.write(data)
    candidate=config(STAGE/'candidate.env',STAGE/'candidate.compose.yml')
    verify_candidate_config(before,candidate)
    assert candidate['services']['ai-worker']['image']==baseline['ai-worker']['imageTag']
    return save('prepared-result.json',{'capturedAt':datetime.now(timezone.utc).isoformat(),'applicationSha':NEW,'imageId':image['Id'],'archiveHashMatches':True,'configAndRootFSMatch':True,'runningNonCoreConfigurationsEqual':True,'oneShotCoreImageAliases':['migrate','embedding-model-verify'],'oneShotHelpersExecuted':False,'existingCoreEnvironmentPreserved':True,'addedCoreEnvironment':dict.fromkeys(QA_ENV,''),'composeOnlyApprovedThreeKeysAdded':True,'candidateEnvSha256':sha(STAGE/'candidate.env'),'servicesSwitched':False,'migrationsRun':False})

def unchanged_files():
    for old,current in [('before.env','.env.pilot'),('before.compose.yml','deploy/pilot/docker-compose.yml'),('before.Caddyfile','deploy/pilot/Caddyfile')]:
        assert (STAGE/old).read_bytes()==(ROOT/current).read_bytes(),current+' changed concurrently'

def expected_capabilities():
    caps=dict(load('before-status.json')['control']['capabilities'])
    caps['replyWhenMentioned']=False
    return caps

def verify_closed(status):
    status_gate(status,True)
    assert status['control']['capabilities']==expected_capabilities()
    assert status['control']['disabledGroupsFingerprint']==load('before-status.json')['control']['disabledGroupsFingerprint']

def database_unchanged(database):
    before=load('before-database.json')
    for key in ['migrations','tablePrivileges','sequencePrivileges','appRole','proseSourcesColumn','domainCounts','jobs','deliveries','answers','policies']:
        assert database[key]==before[key],'database baseline changed: '+key
    assert database['runtime']['desired_global_enabled'] is False
    assert database['runtime']['proactive_speech'] is False and database['runtime']['reply_when_mentioned'] is False

def backup():
    assert load('prepared-result.json')['applicationSha']==NEW
    assert run(['git','rev-parse','HEAD'],'backup-head').strip()==OLD
    unchanged_files()
    preserve_markers()
    status_gate(probe('status.mjs','pre-maintenance-status'))
    disabled=node('''
const call=async(path,method,body)=>{
 const r=await fetch('http://127.0.0.1:3000/internal/runtime-control/'+path,{method,
 headers:{authorization:'Bearer '+process.env.IRIS_INTERNAL_API_TOKEN,'content-type':'application/json','x-iris-operator':'release-aff258f7'},
 body:JSON.stringify(body),signal:AbortSignal.timeout(10000)});
 if(r.status!==200) throw Error('disable_failed');const b=await r.json();
 if(b.durable!==true) throw Error('disable_not_durable');return b;
};
await call('global','POST',{enabled:false});
await call('capabilities','PATCH',{replyWhenMentioned:false});
console.log(JSON.stringify({globalEnabled:false,replyWhenMentioned:false,durable:true}));
''','durable-disable')
    run(DC+['stop','caddy'],'stop-ingress',150)
    assert inspect('caddy')['State']['Running'] is False
    status=probe('status.mjs','closed-status'); verify_closed(status)
    database=probe('database.mjs','closed-database'); database_unchanged(database)
    save('closed-status.json',status); save('closed-database.json',database)
    target=STAGE/'backups'; assert not target.exists()
    env=dict(os.environ,IRIS_BACKUP_DIR=str(target),IRIS_BACKUP_COMMAND_TIMEOUT_SECONDS='300',IRIS_BACKUP_HTTP_TIMEOUT_MS='10000')
    run(['bash','deploy/pilot/backup.sh'],'paired-backup',1200,env=env)
    archives=list(target.glob('iris-*.bundle.tar.age')); assert len(archives)==1
    archive=archives[0]
    assert archive.stat().st_size>0 and archive.stat().st_mode&0o777==0o600
    with archive.open('rb') as f: assert f.read(22)==b'age-encryption.org/v1\n'
    assert inspect('core')['Config']['Image']=='iris-core:'+OLD
    assert inspect('core')['State']['Health']['Status']=='healthy'
    assert inspect('caddy')['State']['Running'] is False
    verify_closed(probe('status.mjs','after-backup-status'))
    return save('backup-result.json',{'capturedAt':datetime.now(timezone.utc).isoformat(),'sourceCommit':OLD,'path':str(archive),'bytes':archive.stat().st_size,'sha256':sha(archive),'mode':'0600','durableDisable':disabled,'defaultAndDedicatedBackupLocks':True,'coreHealthyOldVersion':True,'caddyRunning':False,'offHostDecryptionVerified':False})

def cutover():
    backup_record=load('backup-result.json'); verified=load('backup-verified.json')
    assert backup_record['sourceCommit']==verified['sourceCommit']==OLD
    assert backup_record['sha256']==verified['encryptedArchiveSha256']==sha(Path(backup_record['path']))
    assert all(verified[k] is True for k in ['offHostCopyHashMatches','existingIdentityDecryption','pgRestoreListPassed','redisCheckRdbPassed'])
    assert run(['git','rev-parse','HEAD'],'cutover-head').strip()==OLD
    unchanged_files()
    assert inspect('caddy')['State']['Running'] is False
    assert inspect('core')['Config']['Image']=='iris-core:'+OLD
    verify_closed(probe('status.mjs','cutover-status'))
    database_unchanged(probe('database.mjs','cutover-database'))
    # No schema change exists in this release. Do not invoke migrate or a restore helper.
    verify_source_delta('cutover-approved-source-delta')
    verify_candidate_config(load('before-config.json'),config(STAGE/'candidate.env',STAGE/'candidate.compose.yml'))
    run(DC+['stop','core'],'stop-old-core',150)
    switch_source(NEW,(STAGE/'candidate.compose.yml').read_bytes(),'cutover-source')
    temp=ROOT/'.env.pilot.release-aff258f7'; assert not temp.exists()
    with temp.open('xb') as f: f.write((STAGE/'candidate.env').read_bytes())
    os.chmod(temp,0o600); os.replace(temp,ROOT/'.env.pilot')
    assert (ROOT/'deploy/pilot/docker-compose.yml').read_bytes()==(STAGE/'candidate.compose.yml').read_bytes()
    run(DC+['config','--quiet'],'new-config-valid')
    run(DC+['up','--detach','--no-deps','--no-build','--pull','never','--force-recreate','--wait','--wait-timeout','120','core'],'start-approved-core',180)
    core=inspect('core')
    assert core['Image']==IMAGE and core['Config']['Image']=='iris-core:'+NEW
    assert core['Config']['Labels']['org.opencontainers.image.revision']==NEW and core['State']['Health']['Status']=='healthy'
    assert inspect('caddy')['State']['Running'] is False
    return save('cutover-result.json',{'capturedAt':datetime.now(timezone.utc).isoformat(),'applicationSha':NEW,'imageId':IMAGE,'coreContainerId':core['Id'],'coreHealthy':True,'migrationsRun':False,'caddyRunning':False,'acceptancePending':True})

def accept():
    assert run(['git','rev-parse','HEAD'],'accept-head').strip()==NEW
    baseline=load('before-services.json'); core=inspect('core')
    assert core['Image']==IMAGE and core['State']['Health']['Status']=='healthy'
    assert dict(v.split('=',1) for v in core['Config']['Env'])==expected_live_env(load('before-live-env.json'))
    assert (ROOT/'.env.pilot').read_bytes()==(STAGE/'candidate.env').read_bytes()
    assert (ROOT/'deploy/pilot/docker-compose.yml').read_bytes()==(STAGE/'candidate.compose.yml').read_bytes()
    assert (ROOT/'deploy/pilot/Caddyfile').read_bytes()==(STAGE/'before.Caddyfile').read_bytes()
    for service in SERVICES:
        if service=='core': continue
        current=inspect(service)
        assert current['Id']==baseline[service]['containerId'] and current['Image']==baseline[service]['imageId']
        assert current['State']['Running'] is (service!='caddy')
    ready=probe('readiness.mjs','new-readiness'); assert ready['summary']==load('before-readiness.json')['summary']
    status=probe('status.mjs','new-status'); verify_closed(status)
    database=probe('database.mjs','new-database'); database_unchanged(database)
    save('new-database.json',database)
    try:
        run(DC+['start','caddy'],'reopen-existing-ingress',150)
        caddy=inspect('caddy'); assert caddy['Id']==baseline['caddy']['containerId'] and caddy['State']['Running'] is True
        env=dict(v.split('=',1) for v in caddy['Config']['Env']); host=env['IRIS_PUBLIC_HOSTNAME'].strip()
        origin=host if host.startswith(('https://','http://')) else 'https://'+host
        public={}
        for path,expected in [('/health',200),('/internal/status',404),('/internal/runtime-control/status',404)]:
            code=run(['curl','--silent','--show-error','--output','/dev/null','--write-out','%{http_code}','--connect-timeout','5','--max-time','10','--retry','3','--retry-delay','1','--retry-connrefused',origin.rstrip('/')+path],'public-'+path.replace('/','_'),50)
            public[path]=int(code); assert int(code)==expected
        final=probe('status.mjs','final-status'); verify_closed(final)
        readiness=probe('readiness.mjs','final-readiness'); assert readiness['summary']==ready['summary']
        database_unchanged(probe('database.mjs','final-database'))
        markers=load('before-markers.json')
        for name in MARKERS:
            path=ROOT/name; original=markers[name]
            current=path.read_bytes() if path.exists() else None
            assert current in [bytes.fromhex(original['hex']) if original['existed'] else None,(NEW+'\n').encode()]
            temp=ROOT/(name+'.release-aff258f7'); assert not temp.exists()
            with temp.open('xb') as f: f.write((NEW+'\n').encode())
            os.replace(temp,path)
        return save('acceptance-result.json',{'capturedAt':datetime.now(timezone.utc).isoformat(),'applicationSha':NEW,'imageId':IMAGE,'coreHealthy':True,'existingCoreEnvironmentPreserved':True,'addedCoreEnvironment':dict.fromkeys(QA_ENV,''),'nonCoreContainersUnchanged':True,'caddyfilePreserved':True,'composeOnlyApprovedThreeKeysAdded':True,'databaseBaselinePreserved':True,'migrationsRun':False,'publicHttp':public,'status':final,'readiness':readiness,'feishuMessagesSent':0,'externalModelRequests':0,'globalEnabled':False,'qaEnabled':False,'proactiveDiscussionEnabled':False})
    except Exception:
        run(DC+['stop','caddy'],'reclose-failed-acceptance',150)
        raise

def rollback():
    # Restore only this release's Core/source/env/Compose, never overwrite the database.
    run(DC+['stop','caddy'],'rollback-close-ingress',150)
    run(DC+['stop','core'],'rollback-stop-core',150)
    assert run(['git','rev-parse','HEAD'],'rollback-head').strip() in [OLD,NEW]
    assert (ROOT/'deploy/pilot/Caddyfile').read_bytes()==(STAGE/'before.Caddyfile').read_bytes()
    switch_source(OLD,(STAGE/'before.compose.yml').read_bytes(),'rollback-source')
    temp=ROOT/'.env.pilot.rollback-aff258f7'; assert not temp.exists()
    with temp.open('xb') as f: f.write((STAGE/'before.env').read_bytes())
    os.chmod(temp,0o600); os.replace(temp,ROOT/'.env.pilot')
    run(DC+['up','--detach','--no-deps','--no-build','--pull','never','--force-recreate','--wait','--wait-timeout','120','core'],'rollback-start-old-core',180)
    assert inspect('core')['Image']==load('before-services.json')['core']['imageId']
    verify_closed(probe('status.mjs','rollback-status'))
    database_unchanged(probe('database.mjs','rollback-database'))
    restore_markers()
    return save('rollback-result.json',{'capturedAt':datetime.now(timezone.utc).isoformat(),'applicationSha':OLD,'oldCoreHealthy':True,'globalEnabled':False,'qaEnabled':False,'caddyRunning':False,'databaseRestored':False})

if __name__=='__main__':
    action=sys.argv[1]
    actions={'preflight':preflight,'prepare':prepare,'backup':backup,'cutover':cutover,'accept':accept,'rollback':rollback}
    if action not in actions: raise RuntimeError('unknown action')
    if action in ['backup','cutover','accept','rollback']:
        with (ROOT/'backups/.backup.lock').open('a') as lock:
            fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
            result=actions[action]()
    else: result=actions[action]()
    print(json.dumps(result,indent=2))
