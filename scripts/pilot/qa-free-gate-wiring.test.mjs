import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import test from 'node:test';

test('compiled QA and PD share the permitted loopback gate without external I/O',()=>{
  const result=spawnSync(process.execPath,['scripts/pilot/qa-free-gate-wiring-smoke.mjs'],{
    encoding:'utf8',timeout:30000,windowsHide:true,
  });
  assert.equal(result.status,0,result.stderr || result.stdout);
  const evidence=JSON.parse(result.stdout);
  assert.equal(evidence.providerHttp,0);
  assert.equal(evidence.feishuMessages,0);
  assert.equal(evidence.checks.length,2);
  assert.ok(evidence.checks.every(item=>item.passed));
});
