// Desktop cloud execution over the real managed Code reservation and shared credit ledger
// (docs/ops/desktop-cloud-execution.md). Only the model provider and the model catalogue are fakes, as in
// code-managed-execution.db.test.mjs, and object storage is an in-memory map. Runs on a migrated loopback test database.
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import test,{mock} from 'node:test';
import {Pool} from 'pg';
import {PrismaPg} from '@prisma/adapter-pg';
import {AVAILABLE_MODELS} from '../../lib/models.ts';
import {resolveModelPricing} from '../../lib/modelPricing.ts';
import {validCodeUsage} from '../../lib/codeManagedCore.ts';
import {getSingleAccountCostCeiling,providerBudgetEnvName} from '../../lib/providerCostBudget.ts';
import {catalogContentHash,codingCatalogRowSchema} from '../../lib/modelCatalogCore.ts';

const databaseUrl=process.env.TEST_DATABASE_URL;
const SECRET='synthetic-cloud-runner-secret-0123456789abcdef';
test('Desktop cloud jobs reserve, call, settle and release through the managed Code path',{skip:!databaseUrl},async t=>{
  const url=new URL(databaseUrl);
  assert.ok(['127.0.0.1','localhost'].includes(url.hostname));assert.match(url.pathname,/test/);
  process.env.NEXTAUTH_SECRET='code-cloud-local-synthetic-secret';
  const providerFloor=getSingleAccountCostCeiling();
  for(const provider of ['openai','anthropic'])for(const period of ['day','month'])process.env[providerBudgetEnvName(provider,period)]=String(providerFloor[period]);
  const env={TOMVERSE_DESKTOP_AUTH_ENABLED:'true',TOMVERSE_DESKTOP_ACCOUNT_SETTINGS_ENABLED:'true',TOMVERSE_DESKTOP_CLOUD_EXECUTION_ENABLED:'true',
    CODE_MANAGED_EXECUTION_ENABLED:'true',CODE_CLOUD_RUNNER_SECRET:SECRET};
  Object.assign(process.env,{CODE_MANAGED_EXECUTION_ENABLED:'true'});
  const root=resolve(import.meta.dirname,'../..'),mod=p=>pathToFileURL(resolve(root,p)).href;
  const {PrismaClient}=await import('@prisma/client');
  const pool=new Pool({connectionString:databaseUrl,max:2});
  const db=new PrismaClient({adapter:new PrismaPg(pool)});
  mock.module(mod('lib/prisma.ts'),{namedExports:{prisma:db,prismaPoolUsage:()=>({total:2,idle:0,waiting:0})}});
  const runtimes=AVAILABLE_MODELS.filter(m=>['gpt-6-luna','claude-haiku-4-5'].includes(m.id));
  const rows=runtimes.map(m=>{
    const price=resolveModelPricing(m,{estimatedPromptTokens:10000});
    return {modelId:m.id,name:m.name,provider:m.provider,apiModelId:m.apiModel,minimumPlan:'Pro',capabilities:{toolCalling:'parallel',structuredOutput:'json_mode',imageInput:false,maxContextTokens:10000,maxOutputTokens:1000},pricing:{inputUsdPerMTok:price.inputUsdPerMillionTokens,outputUsdPerMTok:price.outputUsdPerMillionTokens,creditWeight:1,verifiedAt:'2026-10-22',sources:['https://openai.com/fixture']},terms:{allowsResaleAndCodingAgent:true,url:'https://openai.com/fixture',checkedAt:'2026-10-22'},retention:{url:'https://openai.com/fixture',checkedAt:'2026-10-22'},processingRegion:'global'};
  });
  mock.module(mod('lib/modelCatalog.ts'),{namedExports:{loadCodingCatalog:async()=>rows,servableCodingRows:x=>x.map(row=>codingCatalogRowSchema.parse(row))}});
  let dispatches=0,lastRequest;
  mock.module(mod('lib/codeManagedProvider.ts'),{namedExports:{codeProviderCredentialReady:()=>true,prepareCodeProvider:(_model,request)=>{lastRequest=request;return async()=>{
    dispatches++;
    return {validOutput:true,value:{content:'done',tool_calls:[]},usage:validCodeUsage({inputTokens:100,outputTokens:20}),providerReportedModelId:'fixture-provider-model',latencyMs:5};
  };}}});
  const {createCodeCloudService}=await import(mod('lib/codeCloudService.ts'));
  const {enqueueCodeCloudCleanupForUser}=await import(mod('lib/codeCloudDeletion.ts'));
  const {codeTaskLimit}=await import(mod('lib/codeManagedCore.ts'));
  const objects=new Map();
  const storage={put:async(key,bytes)=>{objects.set(key,Buffer.from(bytes));},get:async(key,max)=>{const v=objects.get(key);if(!v||v.length>max)throw new Error('missing');return v;},remove:async key=>{objects.delete(key);}};
  let clock=Date.now();
  const service=createCodeCloudService({storage,env,now:()=>new Date(clock)});
  const coverageUntil=new Date(Date.now()+30*86400000);
  const snapshot=await db.modelCatalogSnapshot.create({data:{category:'coding',contentHash:catalogContentHash(rows),payload:{models:rows},coverageUntil}});
  const newUser=async(plan='Pro')=>{const userId=randomUUID();await db.user.create({data:{id:userId,email:userId+'@example.invalid',plan}});return userId;};
  const bundle=Buffer.from('# v2 git bundle\n'+'a'.repeat(40)+' refs/heads/snapshot\n\nPACK-fixture');
  const sha=b=>createHash('sha256').update(b).digest('hex');
  const createBody=(extra={})=>({action:'create',taskId:randomUUID(),instruction:'Rename the helper and update its callers.',catalogVersion:snapshot.version,contentHash:snapshot.contentHash,
    executorModelId:'gpt-6-luna',reviewerModelId:'claude-haiku-4-5',approvedCredits:20,bundleBytes:bundle.length,bundleSha256:sha(bundle),baseCommit:'b'.repeat(40),...extra});
  const stream=b=>new Response(b).body;
  const rejectCode=(fn,code)=>assert.rejects(fn,e=>e.code===code,code);
  const runner=(request,token=null,secret=SECRET)=>service.handleRunner(secret,token,request);
  const queuedJob=async(user,extra)=>{const job=await service.handle(user,createBody(extra));await service.uploadBundle(user,job.jobId,stream(bundle));return job;};
  const claimed=async()=>{const {job}=await runner({action:'claim',runnerId:'runner-a'});assert.ok(job,'a job was claimed');return job;};
  const modelCall=(job,extra={})=>runner({action:'model',jobId:job.jobId,callId:randomUUID(),prompt:{system:'You are the Tomverse agent.',user:'never store this transcript'},
    schema:{type:'object',properties:{content:{type:'string'},tool_calls:{type:'array'}},required:['content','tool_calls'],additionalProperties:false},maxOutputTokens:500,...extra},job.token);
  const reservation=jobId=>db.codeTaskReservation.findFirst({where:{clientTaskId:jobId}});
  try{
    await t.test('off by default: no switch, no job',async()=>{
      const user=await newUser(),off=createCodeCloudService({storage,env:{...env,TOMVERSE_DESKTOP_CLOUD_EXECUTION_ENABLED:'false'}});
      await rejectCode(()=>off.handle(user,createBody()),'CODE_CLOUD_DISABLED');
      await rejectCode(()=>createCodeCloudService({storage,env:{...env,CODE_CLOUD_RUNNER_SECRET:'short'}}).handle(user,createBody()),'CODE_CLOUD_DISABLED');
      assert.equal(await db.codeCloudJob.count({where:{userId:user}}),0);
    });
    await t.test('create, upload, claim, report, call, finish: credits are the managed reservation from start to end',async()=>{
      const user=await newUser(),other=await newUser();
      const body=createBody(),job=await service.handle(user,body);
      assert.equal(job.status,'uploading');assert.deepEqual(await service.handle(user,body),job);
      await rejectCode(()=>service.handle(user,{...body,instruction:'something else'}),'CODE_CLOUD_IDEMPOTENCY_CONFLICT');
      await rejectCode(()=>service.handle(other,{action:'status',jobId:job.jobId}),'CODE_CLOUD_JOB_NOT_FOUND');
      await rejectCode(()=>service.uploadBundle(user,job.jobId,stream(Buffer.concat([bundle,Buffer.from('x')]))),'CODE_CLOUD_BUNDLE_TOO_LARGE');
      await rejectCode(()=>service.uploadBundle(user,job.jobId,stream(Buffer.from('#'.repeat(bundle.length)))),'CODE_CLOUD_BUNDLE_INVALID');
      assert.equal((await service.uploadBundle(user,job.jobId,stream(bundle))).status,'queued');
      // A queued job holds no credits.
      assert.equal(await reservation(job.jobId),null);
      await rejectCode(()=>runner({action:'claim',runnerId:'runner-a'},null,'wrong-secret-wrong-secret-wrong-secret'),'CODE_CLOUD_RUNNER_FORBIDDEN');
      const claim=await claimed();
      assert.equal(claim.jobId,job.jobId);assert.equal(claim.executor.modelId,'gpt-6-luna');assert.equal(claim.executor.maxOutputTokens,1000);
      const held=await reservation(job.jobId);
      assert.equal(held.status,'active');assert.equal(held.reservedCredits,20);assert.equal(held.userId,user);
      await rejectCode(()=>service.readRunnerBundle(SECRET,'not-the-token',job.jobId),'CODE_CLOUD_JOB_NOT_FOUND');
      assert.deepEqual(await service.readRunnerBundle(SECRET,claim.token,job.jobId),bundle);
      const beat=await runner({action:'heartbeat',jobId:job.jobId,logs:['Reading src/index.ts','line\nwith\u0007control']},claim.token);
      assert.equal(beat.cancel,false);assert.equal(beat.stop,false);assert.equal(beat.billing.reservedCredits,20);
      const seen=await service.handle(user,{action:'status',jobId:job.jobId});
      assert.equal(seen.status,'running');assert.deepEqual(seen.logs,[{seq:1,text:'Reading src/index.ts'},{seq:2,text:'line withcontrol'}]);
      assert.deepEqual((await service.handle(user,{action:'status',jobId:job.jobId,afterLog:1})).logs.map(l=>l.seq),[2]);
      const before=dispatches,answer=await modelCall(claim);
      assert.equal(dispatches,before+1);assert.deepEqual(answer.value,{content:'done',tool_calls:[]});assert.ok(answer.callCredits>0);
      // The reservation's pinned model and the job's reservation, whatever the runner sends.
      assert.equal(lastRequest.modelId,'gpt-6-luna');assert.equal(lastRequest.reservationId,held.id);assert.equal(lastRequest.role,'executor');
      const call=await db.codeManagedCall.findFirst({where:{reservationId:held.id}});
      assert.equal(call.status,'completed');assert.equal(JSON.stringify(call,(_k,v)=>typeof v==='bigint'?String(v):v).includes('never store this transcript'),false);
      await rejectCode(()=>modelCall({...claim,token:'stolen'}),'CODE_CLOUD_JOB_NOT_FOUND');
      const patch=Buffer.from('diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-a\n+b\n');
      await rejectCode(()=>runner({action:'finish',jobId:job.jobId,outcome:'completed',patchBase64:patch.toString('base64'),patchSha256:'0'.repeat(64)},claim.token),'CODE_CLOUD_PATCH_INVALID');
      await runner({action:'finish',jobId:job.jobId,outcome:'completed',summary:'Renamed it.',patchBase64:patch.toString('base64'),patchSha256:sha(patch),logs:['Done']},claim.token);
      const done=await service.handle(user,{action:'status',jobId:job.jobId});
      assert.equal(done.status,'completed');assert.equal(done.summary,'Renamed it.');assert.deepEqual(done.patch,{bytes:patch.length,sha256:sha(patch)});
      assert.equal(done.billing.settledCredits,answer.callCredits);assert.equal(done.billing.releasedCredits,20-answer.callCredits);assert.equal(done.billing.heldCredits,0);
      const closed=await reservation(job.jobId);assert.equal(closed.status,'closed');assert.equal(closed.settledCredits+closed.releasedCredits,20);
      assert.deepEqual((await service.readPatch(user,job.jobId)).bytes,patch);
      await rejectCode(()=>service.readPatch(other,job.jobId),'CODE_CLOUD_JOB_NOT_FOUND');
      // The bundle is gone with the run and the claim token no longer works.
      assert.equal(objects.has(`code-cloud/${job.jobId}/bundle`),false);
      await rejectCode(()=>runner({action:'heartbeat',jobId:job.jobId,logs:[]},claim.token),'CODE_CLOUD_JOB_NOT_FOUND');
    });
    await t.test('a refused reservation fails the job and holds nothing; a cancelled queued job is never claimed',async()=>{
      const user=await newUser();
      const tooMuch=await queuedJob(user,{approvedCredits:1000000});
      const cancelled=await queuedJob(user);
      assert.equal((await service.handle(user,{action:'cancel',jobId:cancelled.jobId})).status,'cancelled');
      assert.equal(objects.has(`code-cloud/${cancelled.jobId}/bundle`),false);
      const {job}=await runner({action:'claim',runnerId:'runner-a'});
      assert.equal(job,null);
      const refused=await service.handle(user,{action:'status',jobId:tooMuch.jobId});
      assert.equal(refused.status,'failed');assert.equal(refused.failureCode,'CREDIT_BALANCE_INSUFFICIENT');
      assert.equal(await reservation(tooMuch.jobId),null);assert.equal(await reservation(cancelled.jobId),null);
    });
    await t.test('stop: a running job is told to cancel and can no longer call a model',async()=>{
      const user=await newUser(),job=await queuedJob(user),claim=await claimed();
      assert.equal((await service.handle(user,{action:'cancel',jobId:job.jobId})).cancelRequested,true);
      assert.equal((await runner({action:'heartbeat',jobId:job.jobId,logs:[]},claim.token)).cancel,true);
      const before=dispatches;await rejectCode(()=>modelCall(claim),'CODE_CLOUD_JOB_NOT_RUNNING');assert.equal(dispatches,before);
      await runner({action:'finish',jobId:job.jobId,outcome:'cancelled'},claim.token);
      const ended=await service.handle(user,{action:'status',jobId:job.jobId});
      assert.equal(ended.status,'cancelled');assert.equal(ended.patch,null);assert.equal((await reservation(job.jobId)).status,'closed');
    });
    await t.test('a runner that stops reporting: the sweep ends the job and its reservation',async()=>{
      const user=await newUser(),job=await queuedJob(user);await claimed();
      clock+=120000;const swept=await service.sweep();clock-=120000;
      assert.ok(swept.lost>=1);
      const lost=await service.handle(user,{action:'status',jobId:job.jobId});
      assert.equal(lost.status,'failed');assert.equal(lost.failureCode,'CODE_CLOUD_RUNNER_LOST');
      const held=await reservation(job.jobId);assert.notEqual(held.status,'active');assert.equal(held.settledCredits,0);assert.equal(held.releasedCredits,20);
    });
    await t.test('a heartbeat that lands after the sweep read a stale claim keeps the job and its reservation',async()=>{
      const user=await newUser(),job=await queuedJob(user),claim=await claimed();
      clock+=120000;
      // The heartbeat arrives between the sweep's read and its conditional end.
      let beaten=false;
      const racing=new Proxy(db,{get(target,key){
        if(key==='$queryRaw'||key==='$executeRaw')return async(strings,...values)=>{
          if(!beaten&&values.includes('CODE_CLOUD_RUNNER_LOST')){beaten=true;await runner({action:'heartbeat',jobId:job.jobId,logs:['still here']},claim.token);}
          return target[key](strings,...values);
        };
        const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;
      }});
      const sweeper=createCodeCloudService({storage,env,now:()=>new Date(clock),db:racing});
      try{await sweeper.sweep();}finally{clock-=120000;}
      assert.equal(beaten,true);
      assert.equal((await service.handle(user,{action:'status',jobId:job.jobId})).status,'running');
      assert.equal((await reservation(job.jobId)).status,'active');
      await runner({action:'finish',jobId:job.jobId,outcome:'failed',failureCode:'CODE_CLOUD_AGENT_ERROR'},claim.token);
      assert.equal((await reservation(job.jobId)).status,'closed');
    });
    await t.test('an account deletion that starts during an upload waits for the write, so its tombstones come after the object',async()=>{
      const user=await newUser(),job=await service.handle(user,createBody());
      let deletion,writtenAt=0;
      // The deletion starts while the bundle bytes are being written and must not commit before they are.
      const slow={...storage,put:async(key,bytes)=>{
        deletion=db.$transaction(tx=>enqueueCodeCloudCleanupForUser(tx,user)).then(()=>Date.now());
        await new Promise(resolve=>setTimeout(resolve,400));
        await storage.put(key,bytes);writtenAt=Date.now();
      }};
      const uploading=createCodeCloudService({storage:slow,env,now:()=>new Date(clock)});
      const outcome=await uploading.uploadBundle(user,job.jobId,stream(bundle)).then(view=>view.status,error=>error.code);
      assert.ok(['queued','CODE_CLOUD_JOB_NOT_FOUND'].includes(outcome),String(outcome));
      const deletedAt=await deletion;
      assert.ok(writtenAt>0&&deletedAt>=writtenAt,'the deletion committed only after the write');
      assert.equal(await db.codeCloudJob.count({where:{id:job.jobId}}),0);
      // The object exists and its tombstone is still open, so the cleanup drain removes it on its next pass.
      assert.equal(objects.has(`code-cloud/${job.jobId}/bundle`),true);
      const tombstone=await db.messageAttachmentCleanup.findUnique({where:{objectKey:`code-cloud/${job.jobId}/bundle`}});
      assert.equal(tombstone.completedAt,null);assert.equal(tombstone.reason,'account_deleted');
      // A deletion that came first leaves no row, and nothing is written for it.
      const late=await newUser(),gone=await service.handle(late,createBody());
      await db.$transaction(tx=>enqueueCodeCloudCleanupForUser(tx,late));
      await rejectCode(()=>service.uploadBundle(late,gone.jobId,stream(bundle)),'CODE_CLOUD_JOB_NOT_FOUND');
      assert.equal(objects.has(`code-cloud/${gone.jobId}/bundle`),false);
    });
    await t.test('the same per-account task limit as the managed path',async()=>{
      const user=await newUser(),limit=codeTaskLimit();
      for(let i=0;i<limit;i++)await service.handle(user,createBody());
      await rejectCode(()=>service.handle(user,createBody()),'CODE_CLOUD_CONCURRENCY_EXCEEDED');
    });
    await t.test('expired uploads fail; finished jobs are removed with their objects after retention',async()=>{
      const user=await newUser(),waiting=await service.handle(user,createBody());
      clock+=16*60000;await service.sweep();clock-=16*60000;
      const expired=await service.handle(user,{action:'status',jobId:waiting.jobId});
      assert.equal(expired.status,'failed');assert.equal(expired.failureCode,'CODE_CLOUD_UPLOAD_EXPIRED');
      objects.set(`code-cloud/${waiting.jobId}/result.patch`,Buffer.from('x'));
      clock+=8*86400000;const swept=await service.sweep(500);clock-=8*86400000;
      assert.ok(swept.purged>=1);assert.equal(await db.codeCloudJob.count({where:{id:waiting.jobId}}),0);
      assert.equal(objects.has(`code-cloud/${waiting.jobId}/result.patch`),false);
    });
    await t.test('account deletion: rows go and every object key gets a tombstone',async()=>{
      const user=await newUser(),job=await queuedJob(user);
      await db.$transaction(tx=>enqueueCodeCloudCleanupForUser(tx,user));
      assert.equal(await db.codeCloudJob.count({where:{userId:user}}),0);
      const tombstones=await db.messageAttachmentCleanup.findMany({where:{objectKey:{in:[`code-cloud/${job.jobId}/bundle`,`code-cloud/${job.jobId}/result.patch`]}}});
      assert.equal(tombstones.length,2);assert.ok(tombstones.every(row=>row.reason==='account_deleted'));
    });
  }finally{
    await db.$disconnect();await pool.end();
  }
});
