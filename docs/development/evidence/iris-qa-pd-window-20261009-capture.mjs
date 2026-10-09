// PRIVATE OUTPUT: capture stdout to a mode-0600 file; never print it to chat or commit it.
// Run inside the existing Core container from /app. No DB writes or model calls.
// --verify-feishu additionally authenticates and GETs only DB-bound exact message IDs.
// It does not list arbitrary chat history, send a message, or mutate delivery state.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {resolve, join} from 'node:path';
import {pathToFileURL} from 'node:url';

const CHAT = 'oc_637a9aca45f01943477f4e17f1fc5b9a';
const FROM = process.env.QA_PD_WINDOW_FROM;
const THROUGH = process.env.QA_PD_WINDOW_THROUGH;
assert.ok(Number.isFinite(Date.parse(FROM)) && Date.parse(THROUGH)>=Date.parse(FROM));
const uniq = values => [...new Set(values.filter(value => typeof value === 'string' && value.length))];
const dist = resolve('apps/core/dist');
const require = createRequire(pathToFileURL(join(dist, 'app.js')));
const {Client} = require('pg');
const db = new Client({connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 5000});

async function rows(sql, values = [], limit = 5000) {
  const result = await db.query(sql, values);
  assert.ok(result.rows.length <= limit, 'capture scope exceeded');
  return result.rows;
}

async function captureDatabase() {
  await db.connect();
  await db.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
  try {
    await db.query("SET LOCAL statement_timeout='10s'");
    const captured = (await db.query('SELECT now() AS snapshot_at, current_setting(\'transaction_read_only\') AS read_only')).rows[0];
    assert.equal(captured.read_only, 'on');
    const jobs = await rows(`SELECT * FROM proactive_discussion_jobs
      WHERE chat_id=$1 AND created_at >= $2 AND created_at <= $3 ORDER BY created_at,id LIMIT 201`, [CHAT,FROM,THROUGH],200);
    const jobIds = jobs.map(row => row.id);
    const evaluations = await rows(`SELECT * FROM proactive_discussion_evaluations
      WHERE chat_id=$1 AND job_id=ANY($2::text[]) ORDER BY created_at,id LIMIT 601`,[CHAT,jobIds],600);
    const evaluationIds = evaluations.map(row => row.id);
    const deliveries = await rows(`SELECT * FROM proactive_discussion_deliveries WHERE chat_id=$1
      AND (evaluation_id=ANY($2::text[]) OR (created_at >= $3 AND created_at <= $4))
      ORDER BY created_at,id LIMIT 201`,[CHAT,evaluationIds,FROM,THROUGH],200);
    const deliveryIds = deliveries.map(row => row.id);
    const qaDeliveries = await rows(`SELECT * FROM answer_reply_deliveries WHERE chat_id=$1
      AND created_at >= $2 AND created_at <= $3 ORDER BY created_at,id LIMIT 101`,[CHAT,FROM,THROUGH],100);
    const qaIds=qaDeliveries.map(row=>row.id);
    const qaEvents=await rows(`SELECT * FROM answer_reply_delivery_events WHERE delivery_id=ANY($1::text[])
      ORDER BY delivery_id,sequence LIMIT 1001`,[qaIds],1000);
    const qaSources=await rows(`SELECT * FROM answer_reply_source_traces WHERE delivery_id=ANY($1::text[])
      ORDER BY delivery_id,prompt_rank LIMIT 1001`,[qaIds],1000);

    // Current group catalog is needed to assess repeats/resolution; it is not a
    // claim that every catalog row was shown to this window's model invocation.
    const issues = await rows('SELECT * FROM proactive_discussion_issues WHERE chat_id=$1 ORDER BY id LIMIT 101',[CHAT],100);
    const sources = await rows(`SELECT * FROM proactive_discussion_sources
      WHERE evaluation_id=ANY($1::text[]) OR delivery_id=ANY($2::text[]) ORDER BY id LIMIT 5001`,[evaluationIds,deliveryIds]);
    const events = await rows(`SELECT * FROM proactive_discussion_events WHERE chat_id=$1 AND
      ((created_at >= $2 AND created_at <= $3) OR
       (entity_type='job' AND entity_id=ANY($4::text[])) OR
       (entity_type='delivery' AND entity_id=ANY($5::text[])) OR
       (entity_type='issue' AND entity_id=ANY($6::text[]))) ORDER BY id LIMIT 5001`,
      [CHAT,FROM,THROUGH,jobIds,deliveryIds,issues.map(row=>row.id)]);
    const bindings = [...sources, ...issues.flatMap(row => [...row.basis_sources, ...(row.prose_sources ?? [])])];
    const messageBindings = bindings.filter(source=>source.kind==='message');
    assert.ok(messageBindings.every(source=>source.binding.chatId===CHAT), 'cross-group message binding');
    const humanIds = uniq([...qaDeliveries.map(row=>row.incoming_message_id), ...jobs.map(row=>row.message_id), ...deliveries.map(row=>row.trigger_message_id),
      ...messageBindings.map(source=>source.binding.messageId)]);
    const replyIds = uniq([...deliveries.map(row=>row.reply_message_id), ...qaDeliveries.flatMap(row=>[row.reply_message_id,row.safe_notice_message_id])]);
    const messageIds = uniq([...humanIds,...replyIds]);
    assert.ok(messageIds.length <= 200, 'capture message scope exceeded');
    const messages = await rows(`SELECT * FROM conversation_messages WHERE chat_id=$1
      AND provider='feishu' AND provider_message_id=ANY($2::text[]) ORDER BY sent_at,id`,[CHAT,messageIds],200);
    const tombstones = await rows(`SELECT * FROM conversation_message_deletion_tombstones
      WHERE chat_id=$1 AND provider='feishu' AND provider_message_id=ANY($2::text[]) ORDER BY deleted_at`,[CHAT,messageIds],200);
    // A useful local comparison, explicitly not a reproduction of live Feishu context.
    const localRecentAtRegistration = await rows(`SELECT j.id AS job_id, to_jsonb(m) AS message
      FROM proactive_discussion_jobs j CROSS JOIN LATERAL
       (SELECT * FROM conversation_messages WHERE chat_id=j.chat_id AND sent_at <= j.created_at
        ORDER BY sent_at DESC,id DESC LIMIT 20) m
      WHERE j.id=ANY($1::text[]) ORDER BY j.id,m.sent_at,m.id`,[jobIds],4000);
    const documentBindings = bindings.filter(source=>source.kind==='document');
    const snapshotIds = uniq(documentBindings.map(source=>source.binding.documentSnapshotId));
    const sourceIds = uniq(documentBindings.map(source=>source.binding.documentSourceId));
    assert.ok(snapshotIds.length <= 100 && sourceIds.length <= 100, 'document capture scope exceeded');
    const snapshots = await rows('SELECT * FROM document_snapshots WHERE id=ANY($1::text[]) ORDER BY id',[snapshotIds],100);
    const documents = await rows('SELECT * FROM document_sources WHERE id=ANY($1::text[]) ORDER BY id',[sourceIds],100);
    const documentEvidence = await rows(`SELECT * FROM document_source_evidence
      WHERE document_source_id=ANY($1::text[]) ORDER BY id LIMIT 5001`,[sourceIds]);
    const fragments = await rows(`SELECT id,document_source_id,document_snapshot_id,source_uri,chunk_index,text,content_hash,created_at
      FROM document_fragments WHERE document_snapshot_id=ANY($1::text[]) ORDER BY document_snapshot_id,chunk_index,id LIMIT 5001`,[snapshotIds]);
    const policy = (await rows('SELECT * FROM proactive_discussion_policies WHERE chat_id=$1',[CHAT],1))[0]??null;
    const group = (await rows('SELECT * FROM proactive_discussion_groups WHERE chat_id=$1',[CHAT],1))[0]??null;
    return {snapshotAt:captured.snapshot_at,readOnly:true,chatId:CHAT,window:{from:FROM,through:THROUGH},
      policy,group,jobs,evaluations,issues,deliveries,sources,events,messages,tombstones,qaDeliveries,qaEvents,qaSources,
      localRecentAtRegistration,documents,snapshots,documentEvidence,fragments,humanIds,replyIds,
      limitations:[
        'PD stores source bindings and versions, not the original context.items or each model request/response body.',
        'Local recent messages are as of registration; live retrieval and exact document fragments selected for the model are not reproduced.',
        'A later Feishu GET proves current readable text/identity, not the original provider state; compare every source hash.',
        'Current issues/policy/group and later associated audit events may postdate the bounded window.',
        'Provider receipt/text equality does not by itself establish semantic correctness.',
      ]};
  } finally {await db.query('ROLLBACK');}
}

async function verifyFeishu(capture) {
  if(capture.humanIds.length===0 && capture.replyIds.length===0) return {attempted:false,reason:'no-bound-message-ids'};
  const {readOptionalFeishuOpenApiConfig}=await import(pathToFileURL(join(dist,'config/env.js')).href);
  const {createFeishuTenantAccessTokenProvider}=await import(pathToFileURL(join(dist,'feishu/feishu-tenant-access-token-provider.js')).href);
  const {createFeishuChatHistoryReader}=await import(pathToFileURL(join(dist,'feishu/feishu-chat-history-reader.js')).href);
  const {hashLocalMessageText}=await import(pathToFileURL(join(dist,'memory/local-message-source.js')).href);
  const {normalizeConversationMessageTextForStorage}=await import(pathToFileURL(join(dist,'conversation/conversation-message-repository.js')).href);
  const config=readOptionalFeishuOpenApiConfig(process.env);
  assert.ok(config);
  const origin=new URL(config.baseUrl).origin;
  assert.ok(['https://open.feishu.cn','https://open.larksuite.com'].includes(origin));
  const allowedPaths=new Set([...capture.humanIds,...capture.replyIds].map(id=>'/open-apis/im/v1/messages/'+encodeURIComponent(id)));
  let authRequests=0,messageGets=0;
  const restrictedFetch=async(url,init)=>{
    const parsed=new URL(url);
    assert.equal(parsed.origin,origin);
    assert.equal(parsed.search,'');assert.equal(parsed.hash,'');
    if(init?.method==='POST' && parsed.pathname==='/open-apis/auth/v3/tenant_access_token/internal') authRequests++;
    else {assert.equal(init?.method,'GET');assert.ok(allowedPaths.has(parsed.pathname));messageGets++;}
    return fetch(url,{...init,redirect:'error'});
  };
  const tokenProvider=createFeishuTenantAccessTokenProvider({...config,timeoutMs:10000,fetch:restrictedFetch});
  const reader=createFeishuChatHistoryReader({baseUrl:config.baseUrl,tokenProvider,assistantAppId:config.appId,timeoutMs:10000,fetch:restrictedFetch});
  const result={attempted:true,observedAt:new Date().toISOString(),authRequests:0,messageGets:0,humanMessages:[],assistantMessages:[],readFailures:[],bindingChecks:[],triggerChecks:[],deliveryChecks:[]};
  for(const [sender,ids,target] of [['user',capture.humanIds,result.humanMessages],['assistant',capture.replyIds,result.assistantMessages]]) {
    for(let offset=0;offset<ids.length;offset+=8) {
      const batch=ids.slice(offset,offset+8);
      try {target.push(...await reader.readMessagesByIds({chatId:CHAT,messageIds:batch,sender}));}
      catch {result.readFailures.push({sender,messageIds:batch,code:'read_unavailable'});}
    }
  }
  const humans=new Map(result.humanMessages.map(message=>[message.messageId,message]));
  const assistants=new Map(result.assistantMessages.map(message=>[message.messageId,message]));
  for(const source of capture.sources.filter(source=>source.kind==='message')) {
    const message=humans.get(source.binding.messageId);
    result.bindingChecks.push({sourceId:source.id,ref:source.ref,messageId:source.binding.messageId,
      found:!!message,contentHashMatches:!!message&&hashLocalMessageText(message.text)===source.binding.contentHash});
  }
  for(const job of capture.jobs) {
    const message=humans.get(job.message_id);
    const normalized=message?normalizeConversationMessageTextForStorage(message.text):null;
    result.triggerChecks.push({jobId:job.id,messageId:job.message_id,found:!!message,
      registrationHashMatches:normalized!==null&&hashLocalMessageText(normalized)===job.content_hash});
  }
  for(const delivery of capture.deliveries) {
    const message=assistants.get(delivery.reply_message_id);
    result.deliveryChecks.push({deliveryId:delivery.id,state:delivery.state,replyMessageId:delivery.reply_message_id,
      found:!!message,textExactlyMatches:!!message&&message.text===delivery.text,
      parentMatchesTrigger:!!message&&message.parentMessageId===delivery.trigger_message_id,
      observedParentMessageId:message?.parentMessageId??null,observedRootMessageId:message?.rootMessageId??null});
  }
  result.qaDeliveryChecks=capture.qaDeliveries.map(delivery=>{
    const message=assistants.get(delivery.reply_message_id);
    return {deliveryId:delivery.id,state:delivery.state,replyMessageId:delivery.reply_message_id,
      found:!!message,parentMatchesIncoming:!!message&&message.parentMessageId===delivery.incoming_message_id,
      observedParentMessageId:message?.parentMessageId??null,safeNoticeMessageId:delivery.safe_notice_message_id};
  });
  result.authRequests=authRequests;result.messageGets=messageGets;return result;
}

try {
  const args=process.argv.slice(2);
  assert.ok(args.length===0 || (args.length===1&&args[0]==='--verify-feishu'));
  assert.ok(!process.stdout.isTTY,'private capture required');
  const capture=await captureDatabase();
  await db.end();
  if(args.length) capture.feishu=await verifyFeishu(capture);
  console.log(JSON.stringify(capture));
} catch {
  await db.end().catch(()=>undefined);
  console.error('private_qa_pd_capture_failed');process.exitCode=1;
}
