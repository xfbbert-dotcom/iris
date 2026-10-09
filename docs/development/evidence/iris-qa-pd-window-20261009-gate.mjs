// Stage as gate.mjs next to the exact candidate's proactive-discussion-free-gate.mjs.
// Operator starts this only for the authorized attended window. Never writes permits.
import assert from 'node:assert/strict';
import {createFreeGate} from './proactive-discussion-free-gate.mjs';
import {writeFile} from 'node:fs/promises';
const parent='/tmp/qa-pd-supervised-20261009';
const CHAT='oc_637a9aca45f01943477f4e17f1fc5b9a';
assert.equal(process.env.IRIS_ANSWER_ALLOWED_GROUP_IDS,CHAT);
assert.equal(process.env.IRIS_PROACTIVE_DISCUSSION_GROUP_IDS,CHAT);
for(const suffix of ['PROVIDER','BASE_URL','API_KEY','NAME','TIMEOUT_MS','STRUCTURED_OUTPUT_MODE','MAX_TOKENS','ENABLE_THINKING']) {
  if(process.env['IRIS_MODEL_'+suffix]!==process.env['IRIS_PROACTIVE_DISCUSSION_MODEL_'+suffix]) throw Error('joint_model_configuration_mismatch');
}
assert.equal(process.env.IRIS_MODEL_BASE_URL,'http://127.0.0.1:8765/v1');
assert.equal(process.env.IRIS_MODEL_NAME,'qwen3.8-max');
assert.equal(process.env.IRIS_MODEL_TIMEOUT_MS,'120000');
assert.equal(process.env.IRIS_MODEL_MAX_TOKENS,'4096');
assert.equal(process.env.IRIS_MODEL_ENABLE_THINKING,'false');
// One instance provides the combined defaults: 8 HTTP, 15 minutes, 60000 reported-token stop.
const gate=createFreeGate({profile:'pd-and-qa',sessionParent:parent,
  apiKey:process.env.IRIS_MODEL_API_KEY,upstreamUrl:process.env.IRIS_QA_PD_WINDOW_UPSTREAM});
await gate.start(8765);
await writeFile(parent+'/gate.json',JSON.stringify({sessionDir:gate.sessionDir,pid:process.pid,
  startedAt:new Date().toISOString(),profile:'pd-and-qa',model:'qwen3.8-max',
  maxRequests:8,windowMs:900000,reportedTokenStop:60000}),{flag:'wx',mode:0o600});
