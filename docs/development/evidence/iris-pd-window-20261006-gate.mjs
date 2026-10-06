// Production wrapper: same Core network namespace, existing protected dedicated env.
import {createFreeGate} from './proactive-discussion-free-gate.mjs';
import {writeFile} from 'node:fs/promises';
const parent='/tmp/iris-pd-supervised-20261006';
const gate=createFreeGate({sessionParent:parent,apiKey:process.env.IRIS_PROACTIVE_DISCUSSION_MODEL_API_KEY,
  upstreamUrl:process.env.IRIS_PD_WINDOW_UPSTREAM});
await gate.start(8765);
await writeFile(parent+'/gate.json',JSON.stringify({sessionDir:gate.sessionDir,pid:process.pid,startedAt:new Date().toISOString()}),{flag:'wx',mode:0o600});
