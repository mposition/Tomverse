import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import test,{mock} from 'node:test';
import {Pool} from 'pg';
import {PrismaPg} from '@prisma/adapter-pg';
import {AVAILABLE_MODELS} from '../../lib/models.ts';
import {getModelPricingProfile,resolveModelPricing} from '../../lib/modelPricing.ts';
import {validCodeUsage} from '../../lib/codeManagedCore.ts';

const databaseUrl=process.env.TEST_DATABASE_URL;
test('Code managed inference with migrated local schema and real shared credit ledger',{skip:!databaseUrl},async t=>{
  const url=new URL(databaseUrl);
  assert.ok(['127.0.0.1','localhost'].includes(url.hostname));assert.match(url.pathname,/test/);
  process.env.NEXTAUTH_SECRET='code-managed-local-synthetic-secret';
  process.env.CODE_MANAGED_EXECUTION_ENABLED='true';
  Object.assign(process.env,{ADMIN_EMAILS:'owner@example.invalid',ADMIN_OWNER_EMAILS:'owner@example.invalid',ADMIN_USER_IDS:'',ADMIN_ACCESS_EXPIRY_JSON:'{}',ADMIN_RECENT_AUTH_MINUTES:'15',ADMIN_AUDIT_INTEGRITY_KEY:'synthetic-code-audit-integrity',CODE_MANAGED_RECONCILIATION_ENABLED:'true'});
  const root=resolve(import.meta.dirname,'../..'),mod=p=>pathToFileURL(resolve(root,p)).href;
  const clientModule=process.env.CODE_MANAGED_TEST_CLIENT_MODULE;
  const {PrismaClient}=await import(clientModule??'@prisma/client');
  const pool=new Pool({connectionString:databaseUrl,max:1});
  const db=new PrismaClient({adapter:new PrismaPg(pool)});
  let failNextSettlement=false,beforeNextTransaction;
  const prisma=new Proxy(db,{get(target,key){
    if(key==='$transaction')return async(callback,...rest)=>{
      if(beforeNextTransaction){const hook=beforeNextTransaction;beforeNextTransaction=undefined;await hook();}
      if(failNextSettlement){failNextSettlement=false;throw new Error('synthetic database outage');}
      return target.$transaction(callback,...rest);
    };
    const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;
  }});
  mock.module(mod('lib/prisma.ts'),{namedExports:{prisma,prismaPoolUsage:()=>({total:1,idle:0,waiting:0})}});
  const runtimes=AVAILABLE_MODELS.filter(m=>['gpt-6-luna','claude-haiku-4-5'].includes(m.id));
  let rows=runtimes.map(m=>{
    const price=resolveModelPricing(m,{estimatedPromptTokens:10000});
    return {modelId:m.id,name:m.name,provider:m.provider,apiModelId:m.apiModel,minimumPlan:'Pro',capabilities:{toolCalling:'parallel',structuredOutput:'json_mode',imageInput:false,maxContextTokens:10000,maxOutputTokens:1000},pricing:{inputUsdPerMTok:price.inputUsdPerMillionTokens,outputUsdPerMTok:price.outputUsdPerMillionTokens,creditWeight:1,verifiedAt:'2026-10-22',sources:['https://openai.com/fixture']},terms:{allowsResaleAndCodingAgent:true,url:'https://openai.com/fixture',checkedAt:'2026-10-22'},retention:{url:'https://openai.com/fixture',checkedAt:'2026-10-22'},processingRegion:'global'};
  });
  const originalRows=structuredClone(rows);let keyReady=true,dispatches=0,mode='success',pending=[],lastPrepared,dynamicDbMode=false;
  const realCatalog=await import(mod('lib/modelCatalog.ts'));
  mock.module(mod('lib/modelCatalog.ts'),{namedExports:{loadCodingCatalog:async()=>dynamicDbMode?realCatalog.servableCodingRows(await realCatalog.loadCodingCatalog()):rows,servableCodingRows:x=>x}});
  mock.module(mod('lib/codeManagedProvider.ts'),{namedExports:{codeProviderCredentialReady:()=>keyReady,prepareCodeProvider:model=>{lastPrepared=model;return async()=>{
    dispatches++;
    if(mode==='pending')await new Promise(resolve=>pending.push(resolve));
    if(mode==='settlement-failure')failNextSettlement=true;
    return {validOutput:mode!=='schema-failure',value:{ok:true},usage:mode==='unknown'?null:validCodeUsage({inputTokens:100,outputTokens:mode==='over-output'?101:20,cachedInputTokens:20,cacheWriteInputTokens:dynamicDbMode?0:10,reasoningTokens:15}),providerReportedModelId:'fixture-provider-model',latencyMs:5};
  }}}});
  const service=await import(mod('lib/codeManagedService.ts'));
  const snapshot=await db.modelCatalogSnapshot.create({data:{category:'coding',contentHash:'fixture-hash',payload:{models:rows},coverageUntil:new Date(Date.now()+3600000)}});
  const newUser=async(plan='Pro')=>{const userId=randomUUID();await db.user.create({data:{id:userId,email:userId+'@example.invalid',plan}});return userId;};
  const reserve=(userId,approvedCredits=20,taskId=randomUUID())=>service.handleCodeManaged(userId,{action:'reserve',taskId,catalogVersion:snapshot.version,contentHash:snapshot.contentHash,executorModelId:'gpt-6-luna',reviewerModelId:'claude-haiku-4-5',approvedCredits});
  const call=(reservationId,extra={})=>({action:'complete',reservationId,callId:randomUUID(),role:'executor',modelId:'gpt-6-luna',prompt:{system:'fixture only',user:'never persist this private prompt'},schema:{type:'object',properties:{ok:{type:'boolean'}},required:['ok'],additionalProperties:false},maxOutputTokens:100,...extra});
  const rejectCode=(fn,code)=>assert.rejects(fn,error=>error.code===code);
  const release=(userId,reservationId)=>service.handleCodeManaged(userId,{action:'release',reservationId,terminalReason:'completed'});
  const owner={user:{id:'synthetic-owner',email:'owner@example.invalid',authenticatedAt:new Date().toISOString()},expires:new Date(Date.now()+3600000).toISOString()};
  const reconcile=input=>service.reconcileCodeManagedCall(owner,new Request('https://tomverse.app/api/admin/code/managed-reconciliation',{method:'POST'}),input);
  const waitPending=async count=>{for(let i=0;i<1000;i++){if(pending.length>=count)return;await new Promise(r=>setTimeout(r,5));}throw new Error('fixture provider did not start');};
  try{
    await t.test('default-off produces no reservation or provider call',async()=>{
      const user=await newUser(),before=dispatches;process.env.CODE_MANAGED_EXECUTION_ENABLED='false';
      await rejectCode(()=>reserve(user),'CODE_MANAGED_DISABLED');assert.equal(dispatches,before);
      process.env.CODE_MANAGED_EXECUTION_ENABLED='true';
    });
    await t.test('reservation binding, ownership, success settlement and duplicate IDs',async()=>{
      const user=await newUser(),other=await newUser(),taskId=randomUUID();const held=await reserve(user,20,taskId);
      assert.deepEqual((await reserve(user,20,taskId)).billing,held.billing);
      await rejectCode(()=>reserve(user,21,taskId),'CODE_TASK_IDEMPOTENCY_CONFLICT');
      await rejectCode(()=>service.handleCodeManaged(other,{action:'status',reservationId:held.reservationId}),'CODE_RESERVATION_NOT_FOUND');
      const req=call(held.reservationId),result=await service.handleCodeManaged(user,req),before=dispatches;
      assert.equal(result.callCredits,1);assert.equal(result.billing.settledCredits,1);assert.equal(result.usage.reasoningTokens,15);
      await rejectCode(()=>service.handleCodeManaged(user,req),'CODE_CALL_ALREADY_DISPATCHED');
      await rejectCode(()=>service.handleCodeManaged(user,{...req,prompt:{...req.prompt,user:'mutated'}}),'CODE_CALL_IDEMPOTENCY_CONFLICT');
      assert.equal(dispatches,before);const closed=await release(user,held.reservationId);
      assert.equal(closed.billing.releasedCredits,19);assert.equal(closed.billing.heldCredits,0);
      const task=await db.codeTaskReservation.findUnique({where:{id:held.reservationId}});assert.equal(task.productKey,'code');
      assert.equal(JSON.stringify(task,(_k,v)=>typeof v==='bigint'?String(v):v).includes(req.prompt.user),false);
      const paid=await db.codeManagedCall.findUnique({where:{id:req.callId}});assert.ok(paid.settledCostMicroUsd>0n);
      assert.deepEqual((await release(user,held.reservationId)).billing,closed.billing);
      const otherHeld=await reserve(other),collision={...req,reservationId:otherHeld.reservationId};
      await assert.rejects(()=>service.handleCodeManaged(other,collision),e=>e.code==='CODE_CALL_IDEMPOTENCY_CONFLICT'&&e.dispatchState==='not_dispatched');assert.equal(dispatches,before);await release(other,otherHeld.reservationId);
    });
    await t.test('every call rechecks current model, plan, immutable catalog and credential availability',async()=>{
      const user=await newUser(),held=await reserve(user),before=dispatches;
      rows=[];await rejectCode(()=>service.handleCodeManaged(user,call(held.reservationId)),'CODE_MODEL_UNAVAILABLE');rows=structuredClone(originalRows);
      await db.user.update({where:{id:user},data:{plan:'Free'}});await rejectCode(()=>service.handleCodeManaged(user,call(held.reservationId)),'CODE_MODEL_PLAN_FORBIDDEN');await db.user.update({where:{id:user},data:{plan:'Pro'}});
      await db.modelCatalogSnapshot.update({where:{version:snapshot.version},data:{coverageUntil:new Date(0)}});await rejectCode(()=>service.handleCodeManaged(user,call(held.reservationId)),'CODE_CATALOG_STALE');await db.modelCatalogSnapshot.update({where:{version:snapshot.version},data:{coverageUntil:new Date(Date.now()+3600000)}});
      keyReady=false;await rejectCode(()=>service.handleCodeManaged(user,call(held.reservationId)),'CODE_PROVIDER_UNAVAILABLE');keyReady=true;
      await rejectCode(()=>service.handleCodeManaged(user,call(held.reservationId,{maxOutputTokens:1001})),'CODE_REQUEST_BOUNDS_INVALID');
      assert.equal(dispatches,before);assert.equal(await db.codeManagedCall.count({where:{reservationId:held.reservationId}}),0);await release(user,held.reservationId);
    });
    await t.test('catalogue-only model needs no static model/price entry and dispatches its pinned API ID',async()=>{
      const dynamic={...structuredClone(originalRows[0]),modelId:'code-fixture-only-catalog',apiModelId:'gpt-fixture-dynamic',pricing:{...originalRows[0].pricing,inputUsdPerMTok:2,outputUsdPerMTok:5}};
      const reviewer=structuredClone(originalRows[1]);reviewer.pricing.sources=['https://anthropic.com/fixture'];reviewer.terms.url='https://anthropic.com/fixture';reviewer.retention.url='https://anthropic.com/fixture';
      for(const row of [dynamic,reviewer]){const {modelId,...profile}=row;await db.modelCatalogEntry.create({data:{category:'coding',modelId,enabled:true,profile}});}
      assert.equal(AVAILABLE_MODELS.some(m=>m.id===dynamic.modelId),false);assert.equal(getModelPricingProfile(dynamic.modelId),undefined);
      const published=await db.modelCatalogSnapshot.create({data:{category:'coding',contentHash:'catalog-only-fixture',payload:{models:[dynamic,reviewer]},coverageUntil:new Date(Date.now()+3600000)}});
      dynamicDbMode=true;const user=await newUser();
      try{
        const held=await service.handleCodeManaged(user,{action:'reserve',taskId:randomUUID(),catalogVersion:published.version,contentHash:published.contentHash,executorModelId:dynamic.modelId,reviewerModelId:reviewer.modelId,approvedCredits:20});
        const req=call(held.reservationId,{modelId:dynamic.modelId}),result=await service.handleCodeManaged(user,req);
        assert.equal(lastPrepared.apiModel,dynamic.apiModelId);assert.equal(result.model.apiModelId,dynamic.apiModelId);
        const row=await db.codeManagedCall.findUnique({where:{id:req.callId}});assert.equal(row.settledCostMicroUsd,300n);assert.equal(row.pricingSnapshot.input,2);assert.equal(row.pricingSnapshot.output,5);assert.equal(row.pricingSnapshot.catalogVersion,published.version);assert.equal(row.productKey,'code');
        await db.modelCatalogEntry.update({where:{category_modelId:{category:'coding',modelId:dynamic.modelId}},data:{enabled:false}});
        const before=dispatches;await rejectCode(()=>service.handleCodeManaged(user,call(held.reservationId,{modelId:dynamic.modelId})),'CODE_MODEL_UNAVAILABLE');assert.equal(dispatches,before);await release(user,held.reservationId);
      }finally{dynamicDbMode=false;}
    });
    await t.test('plan changes between precheck and monetary admission are rechecked under the account lock',async()=>{
      const user=await newUser(),before=dispatches;
      beforeNextTransaction=()=>db.user.update({where:{id:user},data:{plan:'Free'}});
      await rejectCode(()=>reserve(user),'CODE_MODEL_PLAN_FORBIDDEN');assert.equal(await db.codeTaskReservation.count({where:{userId:user}}),0);
      await db.user.update({where:{id:user},data:{plan:'Pro'}});const held=await reserve(user);
      beforeNextTransaction=()=>db.user.update({where:{id:user},data:{plan:'Free'}});
      await rejectCode(()=>service.handleCodeManaged(user,call(held.reservationId)),'CODE_MODEL_PLAN_FORBIDDEN');
      assert.equal(dispatches,before);assert.equal(await db.codeManagedCall.count({where:{reservationId:held.reservationId}}),0);await release(user,held.reservationId);
    });
    await t.test('a small prompt on a large-context catalog model fits one credit and then respects the true cap',async()=>{
      const cheap={...structuredClone(originalRows[0]),modelId:'code-cheap-large-context',apiModelId:'cheap-large-fixture',capabilities:{...originalRows[0].capabilities,maxContextTokens:1000000},pricing:{...originalRows[0].pricing,inputUsdPerMTok:0.1,outputUsdPerMTok:0.5}};
      const {modelId,...profile}=cheap;await db.modelCatalogEntry.create({data:{category:'coding',modelId,enabled:true,profile}});
      const reviewer=structuredClone(originalRows[1]);reviewer.pricing.sources=['https://anthropic.com/fixture'];reviewer.terms.url='https://anthropic.com/fixture';reviewer.retention.url='https://anthropic.com/fixture';
      const published=await db.modelCatalogSnapshot.create({data:{category:'coding',contentHash:'small-prompt-fixture',payload:{models:[cheap,reviewer]},coverageUntil:new Date(Date.now()+3600000)}});
      const user=await newUser();dynamicDbMode=true;
      try{
        const held=await service.handleCodeManaged(user,{action:'reserve',taskId:randomUUID(),catalogVersion:published.version,contentHash:published.contentHash,executorModelId:modelId,reviewerModelId:reviewer.modelId,approvedCredits:1});const req=call(held.reservationId,{modelId});
        await service.handleCodeManaged(user,req);const row=await db.codeManagedCall.findUnique({where:{id:req.callId}});assert.ok(row.pricingSnapshot.maxInput<10000);assert.ok(row.reservedCostMicroUsd<40000n);assert.equal(row.reservedCredits,1);
        await rejectCode(()=>service.handleCodeManaged(user,call(held.reservationId,{modelId})),'CODE_TASK_CAP_EXCEEDED');await release(user,held.reservationId);
      }finally{dynamicDbMode=false;}
    });
    await t.test('catalogue field order cannot spuriously revoke an unchanged model',async()=>{
      rows=originalRows.map(row=>Object.fromEntries(Object.entries(row).reverse()));const user=await newUser();
      try{const held=await reserve(user);await service.handleCodeManaged(user,call(held.reservationId));await release(user,held.reservationId);}finally{rows=structuredClone(originalRows);}
    });
    await t.test('concurrent calls never exceed task credits and share provider/operational buckets',async()=>{
      const user=await newUser(),held=await reserve(user,2);mode='pending';const first=service.handleCodeManaged(user,call(held.reservationId));
      await waitPending(1);
      const second=service.handleCodeManaged(user,call(held.reservationId));await waitPending(2);
      await rejectCode(()=>service.handleCodeManaged(user,call(held.reservationId)),'CODE_TASK_CAP_EXCEEDED');
      const task=await db.codeTaskReservation.findUnique({where:{id:held.reservationId}});
      const calls=await db.codeManagedCall.findMany({where:{reservationId:held.reservationId}});assert.equal(calls.reduce((s,c)=>s+c.reservedCredits,0),2);
      const buckets=await db.chatUsageBucket.findMany({where:{OR:[{key:task.subjectKey},{key:'provider:openai'}]}});
      assert.ok(buckets.some(b=>b.period==='op-cost-day'&&b.count>=task.heldCostMicroUsd));assert.ok(buckets.some(b=>b.period==='provider-cost-day'&&b.count>0));
      pending.splice(0).forEach(resolve=>resolve());await Promise.all([first,second]);mode='success';await release(user,held.reservationId);
    });
    await t.test('known schema failure records provider cost but refunds user credits',async()=>{
      const user=await newUser(),held=await reserve(user),req=call(held.reservationId);mode='schema-failure';
      await assert.rejects(()=>service.handleCodeManaged(user,req),error=>error.code==='CODE_OUTPUT_INVALID'&&error.metadata.usage.cacheWriteInputTokens===10&&error.receipt.billing.settledCredits===0);
      mode='success';const row=await db.codeManagedCall.findUnique({where:{id:req.callId}});assert.equal(row.status,'failed');assert.ok(row.settledCostMicroUsd>0n);
      const closed=await release(user,held.reservationId);assert.equal(closed.billing.releasedCredits,20);assert.equal(closed.billing.heldCredits,0);
    });
    await t.test('unknown outcomes and output-bound overruns retain hold through release and orphan sweep',async()=>{
      for(const selectedMode of ['unknown','over-output','settlement-failure']){
        const user=await newUser(),held=await reserve(user),req=call(held.reservationId);mode=selectedMode;
        await assert.rejects(()=>service.handleCodeManaged(user,req),e=>e.dispatchState==='dispatched');mode='success';
        const released=await release(user,held.reservationId);assert.equal(released.billing.heldCredits,1);assert.equal(released.billing.settledCredits,0);
        await db.codeManagedCall.update({where:{id:req.callId},data:{createdAt:new Date(Date.now()-180000)}});
        await service.reconcileExpiredCodeTasks(new Date());
        const status=await service.handleCodeManaged(user,{action:'status',reservationId:held.reservationId,callId:req.callId});
        assert.equal(status.state,'outcome_unknown');assert.equal(status.billing.unknownHeldCredits,1);assert.equal(status.billing.heldCredits,1);assert.equal(status.billing.releasedCredits,19);
        const before=dispatches;await rejectCode(()=>service.handleCodeManaged(user,req),'CODE_CALL_ALREADY_DISPATCHED');assert.equal(dispatches,before);
      }
    });
    await t.test('purchased-credit reserve and proven-unused refund use existing lot ledger',async()=>{
      const user=await newUser('Free');const lot=await db.creditLot.create({data:{userId:user,source:'synthetic',originalCredits:400,remainingCredits:400,originalFundedCostMicroUsd:16000000n,remainingFundedCostMicroUsd:16000000n,expiresAt:new Date(Date.now()+3600000)}});
      await db.user.update({where:{id:user},data:{plan:'Pro'}});
      const {getUserChatUsageKey,usagePeriodStart}=await import(mod('lib/chatSecurity.ts'));
      await db.chatUsageBucket.create({data:{key:getUserChatUsageKey(user),period:'month',periodStart:usagePeriodStart('month',new Date()),count:2990n}});
      const held=await reserve(user,100);const reservedLot=await db.creditLot.findUnique({where:{id:lot.id}});assert.ok(reservedLot.remainingCredits<400);
      await release(user,held.reservationId);const refunded=await db.creditLot.findUnique({where:{id:lot.id}});assert.equal(refunded.remainingCredits,400);assert.equal(refunded.remainingFundedCostMicroUsd,16000000n);
      assert.ok(await db.creditLedgerEntry.count({where:{reservationId:held.reservationId}})>0);
      await db.chatUsageBucket.update({where:{key_period_periodStart:{key:getUserChatUsageKey(user),period:'month',periodStart:usagePeriodStart('month',new Date())}},data:{count:3000n}});
      const spent=await reserve(user,20);await service.handleCodeManaged(user,call(spent.reservationId));await release(user,spent.reservationId);
      assert.equal((await db.creditLot.findUnique({where:{id:lot.id}})).remainingCredits,399);
      const settled=await db.creditLedgerEntry.findMany({where:{reservationId:spent.reservationId,type:'settle'}});
      assert.equal(settled.reduce((sum,row)=>sum+Number(row.metadata.settledCredits??0),0),1);
      assert.ok(settled.some(row=>Number(row.metadata.settledFundedCostMicroUsd)>0));
    });
    await t.test('insufficient purchased funding returns an entitlement error with no partial reservation',async()=>{
      const user=await newUser();const {getUserChatUsageKey,usagePeriodStart}=await import(mod('lib/chatSecurity.ts'));
      await db.chatUsageBucket.create({data:{key:getUserChatUsageKey(user),period:'month',periodStart:usagePeriodStart('month',new Date()),count:3000n}});
      await db.creditLot.create({data:{userId:user,source:'synthetic',originalCredits:100,remainingCredits:100,expiresAt:new Date(Date.now()+3600000)}});
      await rejectCode(()=>reserve(user),'ADDON_COST_ALLOWANCE_INSUFFICIENT');assert.equal(await db.codeTaskReservation.count({where:{userId:user}}),0);
      const event=await db.chatLimitDecisionEvent.findFirst({where:{userId:user,errorCode:'ADDON_COST_ALLOWANCE_INSUFFICIENT'}});assert.equal(event.limitLayer,'entitlement');
    });
    await t.test('operator resolution is idempotent, keeps other unknown holds and never charges/replays a customer',async()=>{
      const user=await newUser(),held=await reserve(user),a=call(held.reservationId),b=call(held.reservationId);mode='pending';
      const first=service.handleCodeManaged(user,a).catch(e=>e),second=service.handleCodeManaged(user,b).catch(e=>e);await waitPending(2);mode='unknown';pending.splice(0).forEach(r=>r());await Promise.all([first,second]);mode='success';await release(user,held.reservationId);
      const body={callId:a.callId,resolutionId:randomUUID(),evidenceRef:'ticket/code-fixture-1',mode:'no_provider_usage'},before=dispatches;
      process.env.CODE_MANAGED_RECONCILIATION_ENABLED='false';await rejectCode(()=>reconcile(body),'CODE_RECONCILIATION_DISABLED');process.env.CODE_MANAGED_RECONCILIATION_ENABLED='true';
      await assert.rejects(()=>service.reconcileCodeManagedCall({...owner,user:{...owner.user,email:'other@example.invalid'}},new Request('https://tomverse.app'),body),e=>e.code==='CODE_RECONCILIATION_FORBIDDEN');
      await assert.rejects(()=>service.reconcileCodeManagedCall({...owner,user:{...owner.user,authenticatedAt:new Date(Date.now()-3600000).toISOString()}},new Request('https://tomverse.app'),body),e=>e.name==='AdminReauthenticationRequiredError');
      const resolved=await reconcile(body);assert.deepEqual(await reconcile(body),resolved);await rejectCode(()=>reconcile({...body,evidenceRef:'ticket/changed'}),'CODE_RESOLUTION_IDEMPOTENCY_CONFLICT');await rejectCode(()=>reconcile({...body,callId:b.callId}),'CODE_RESOLUTION_IDEMPOTENCY_CONFLICT');
      let status=await service.handleCodeManaged(user,{action:'status',reservationId:held.reservationId});assert.equal(status.billing.unknownHeldCredits,1);assert.equal(status.billing.settledCredits,0);assert.equal(status.billing.releasedCredits,19);
      const bad={callId:b.callId,resolutionId:randomUUID(),evidenceRef:'ticket/code-fixture-2',mode:'known_usage',usage:{inputTokens:9999999,outputTokens:20}};
      await rejectCode(()=>reconcile(bad),'CODE_RECONCILIATION_USAGE_OUT_OF_BOUNDS');assert.equal((await service.handleCodeManaged(user,{action:'status',reservationId:held.reservationId})).billing.unknownHeldCredits,1);
      await reconcile({...bad,usage:{inputTokens:100,outputTokens:20,cachedInputTokens:20,reasoningTokens:15}});status=await service.handleCodeManaged(user,{action:'status',reservationId:held.reservationId});assert.equal(status.billing.heldCredits,0);assert.equal(status.billing.releasedCredits,20);assert.equal(status.billing.settledCredits,0);
      const audited=await db.adminAuditLog.findUnique({where:{id:resolved.auditLogId}});assert.match(audited.entryHash,/^[0-9a-f]{64}$/);assert.equal(JSON.stringify(audited).includes('never persist this private prompt'),false);
      assert.equal(dispatches,before);await rejectCode(()=>service.handleCodeManaged(user,call(held.reservationId)),'CODE_TASK_NOT_ACTIVE');
    });
    await t.test('deleted-account resolution preserves numeric allocation evidence and only releases global provider holds',async()=>{
      const user=await newUser();const {getUserChatUsageKey,usagePeriodStart}=await import(mod('lib/chatSecurity.ts'));
      await db.chatUsageBucket.create({data:{key:getUserChatUsageKey(user),period:'month',periodStart:usagePeriodStart('month',new Date()),count:3000n}});
      const lot=await db.creditLot.create({data:{userId:user,source:'synthetic',originalCredits:100,remainingCredits:100,originalFundedCostMicroUsd:4000000n,remainingFundedCostMicroUsd:4000000n,expiresAt:new Date(Date.now()+3600000)}});
      const held=await reserve(user),req=call(held.reservationId);mode='unknown';await assert.rejects(()=>service.handleCodeManaged(user,req));mode='success';await release(user,held.reservationId);
      const {anonymiseAccountData}=await import(mod('lib/accountDataAnonymisation.ts'));await db.$transaction(tx=>anonymiseAccountData(tx,user));await db.user.delete({where:{id:user}});
      const snapshot=await db.codeTaskReservation.findUnique({where:{id:held.reservationId}});assert.equal(snapshot.addOnEntries.unlinked,true);assert.equal(snapshot.addOnEntries.credits,1);assert.equal(JSON.stringify(snapshot.addOnEntries).includes(lot.id),false);
      const providerBefore=await db.chatUsageBucket.findUnique({where:{key_period_periodStart:{key:'provider:openai',period:'provider-cost-day',periodStart:usagePeriodStart('day',new Date())}}});
      const callBefore=await db.codeManagedCall.findUnique({where:{id:req.callId}});await reconcile({callId:req.callId,resolutionId:randomUUID(),evidenceRef:'ticket/deleted-fixture',mode:'no_provider_usage'});
      const after=await db.codeTaskReservation.findUnique({where:{id:held.reservationId}});assert.equal(after.userId,null);assert.equal(after.reservedCredits-after.settledCredits-after.releasedCredits,0);assert.deepEqual(after.addOnEntries,snapshot.addOnEntries);assert.equal(await db.user.findUnique({where:{id:user}}),null);assert.equal(await db.creditLot.count({where:{userId:user}}),0);
      const providerAfter=await db.chatUsageBucket.findUnique({where:{key_period_periodStart:{key:'provider:openai',period:'provider-cost-day',periodStart:usagePeriodStart('day',new Date())}}});assert.equal(providerBefore.count-providerAfter.count,callBefore.reservedCostMicroUsd);
    });
    await t.test('late provider callbacks cannot overwrite a terminal operator resolution',async()=>{
      const user=await newUser(),held=await reserve(user),req=call(held.reservationId);mode='pending';const late=service.handleCodeManaged(user,req).catch(e=>e);await waitPending(1);
      await db.codeManagedCall.update({where:{id:req.callId},data:{createdAt:new Date(Date.now()-180000)}});await service.reconcileExpiredCodeTasks(new Date());
      const resolved=await reconcile({callId:req.callId,resolutionId:randomUUID(),evidenceRef:'ticket/late-fixture',mode:'no_provider_usage'});mode='success';pending.splice(0).forEach(r=>r());await late;
      const row=await db.codeManagedCall.findUnique({where:{id:req.callId}});assert.equal(row.status,'failed');assert.equal(row.resolutionAuditId,resolved.auditLogId);assert.equal(row.settledCostMicroUsd,0n);assert.equal((await service.handleCodeManaged(user,{action:'status',reservationId:held.reservationId})).billing.heldCredits,0);
    });
    await t.test('a plan with no daily ceiling never refunds somebody else’s existing day usage',async()=>{
      const user=await newUser('Max');const {getUserChatUsageKey,usagePeriodStart}=await import(mod('lib/chatSecurity.ts'));
      const key=getUserChatUsageKey(user),periodStart=usagePeriodStart('day',new Date());
      await db.chatUsageBucket.create({data:{key,period:'day',periodStart,count:7n}});
      const held=await reserve(user);assert.equal((await db.codeTaskReservation.findUnique({where:{id:held.reservationId}})).planDayHeld,false);
      await release(user,held.reservationId);const bucket=await db.chatUsageBucket.findUnique({where:{key_period_periodStart:{key,period:'day',periodStart}}});assert.equal(bucket.count,7n);
    });
    await t.test('expired task slots recover immediately and one failed refund does not poison the rest of the sweep',async()=>{
      const user=await newUser(),ids=[];for(let i=0;i<8;i++){const held=await reserve(user,1);ids.push(held.reservationId);await db.codeTaskReservation.update({where:{id:held.reservationId},data:{leaseExpiresAt:new Date(Date.now()-1000)}});}
      const ninth=await reserve(user,1);failNextSettlement=true;const swept=await service.reconcileExpiredCodeTasks(new Date());assert.equal(swept.failed,1);assert.equal(swept.interrupted,7);
      assert.equal(await db.codeTaskReservation.count({where:{id:{in:ids},status:'interrupted'}}),7);assert.equal(await db.codeTaskReservation.count({where:{id:{in:ids},status:'active'}}),1);
      assert.equal((await service.reconcileExpiredCodeTasks(new Date())).interrupted,1);await release(user,ninth.reservationId);
    });
    await t.test('pruned old-period usage buckets do not trap purchased refunds or known provider settlement',async()=>{
      const user=await newUser(),{getUserChatUsageKey,usagePeriodStart}=await import(mod('lib/chatSecurity.ts')),subject=getUserChatUsageKey(user);
      await db.chatUsageBucket.create({data:{key:subject,period:'month',periodStart:usagePeriodStart('month',new Date()),count:3000n}});
      const lot=await db.creditLot.create({data:{userId:user,source:'synthetic',originalCredits:100,remainingCredits:100,originalFundedCostMicroUsd:4000000n,remainingFundedCostMicroUsd:4000000n,expiresAt:new Date(Date.now()+3600000)}});
      const held=await reserve(user);const oldDay=new Date(usagePeriodStart('day',new Date()).getTime()-86400000),oldMonth=new Date(Date.UTC(oldDay.getUTCFullYear(),oldDay.getUTCMonth()-1,1));
      await db.codeTaskReservation.update({where:{id:held.reservationId},data:{dayStart:oldDay,monthStart:oldMonth}});await db.chatUsageBucket.deleteMany({where:{key:subject}});
      await release(user,held.reservationId);assert.equal((await db.creditLot.findUnique({where:{id:lot.id}})).remainingCredits,100);
      const other=await newUser(),active=await reserve(other),req=call(active.reservationId);mode='pending';const running=service.handleCodeManaged(other,req);await waitPending(1);
      await db.chatUsageBucket.updateMany({where:{key:'provider:openai',period:'provider-cost-day'},data:{periodStart:oldDay}});await db.chatUsageBucket.deleteMany({where:{key:'provider:openai',period:'provider-cost-day'}});
      if(usagePeriodStart('month',oldDay).getTime()!==usagePeriodStart('month',new Date()).getTime())await db.chatUsageBucket.updateMany({where:{key:'provider:openai',period:'provider-cost-month'},data:{periodStart:usagePeriodStart('month',oldDay)}});
      await db.codeManagedCall.update({where:{id:req.callId},data:{createdAt:new Date(oldDay.getTime()+1000)}});mode='success';pending.splice(0).forEach(r=>r());assert.equal((await running).dispatchState,'dispatched');await release(other,active.reservationId);
      const current=await newUser(),currentHeld=await reserve(current),currentReq=call(currentHeld.reservationId);mode='pending';const invalid=service.handleCodeManaged(current,currentReq).catch(e=>e);await waitPending(1);
      await db.chatUsageBucket.updateMany({where:{key:'provider:openai',period:'provider-cost-day'},data:{count:0n}});mode='success';pending.splice(0).forEach(r=>r());assert.equal((await invalid).code,'CODE_SETTLEMENT_OUTCOME_UNKNOWN');assert.equal((await release(current,currentHeld.reservationId)).billing.heldCredits,1);
    });
    await t.test('current user-time-zone day buckets still reject underflow',async tt=>{
      tt.mock.timers.enable({apis:['Date'],now:new Date('2026-10-22T12:00:00Z')});
      try{
        await db.modelCatalogSnapshot.update({where:{version:snapshot.version},data:{coverageUntil:new Date(Date.now()+3600000)}});
        for(const period of ['day','cost-day','op-cost-day']){
          const user=await newUser();await db.userSettings.create({data:{userId:user,timeZone:'Australia/Brisbane',defaultModel:'gpt-6-luna'}});
          const held=await reserve(user),task=await db.codeTaskReservation.findUnique({where:{id:held.reservationId}});
          assert.equal(task.dayStart.toISOString(),'2026-10-21T14:00:00.000Z');
          const where={key_period_periodStart:{key:task.subjectKey,period,periodStart:task.dayStart}},bucket=await db.chatUsageBucket.findUnique({where});
          await db.chatUsageBucket.update({where,data:{count:0n}});
          await rejectCode(()=>release(user,held.reservationId),'CODE_ACCOUNTING_UNAVAILABLE');
          assert.equal((await db.codeTaskReservation.findUnique({where:{id:held.reservationId}})).releasedCredits,0);
          await db.chatUsageBucket.update({where,data:{count:bucket.count}});await release(user,held.reservationId);
        }
      }finally{
        tt.mock.timers.reset();await db.modelCatalogSnapshot.update({where:{version:snapshot.version},data:{coverageUntil:new Date(Date.now()+3600000)}});
      }
    });
    await t.test('deletion during dispatch remains recoverable without recreating a wallet',async()=>{
      const user=await newUser(),held=await reserve(user,1),req=call(held.reservationId);mode='pending';const late=service.handleCodeManaged(user,req).catch(e=>e);await waitPending(1);
      try{
        const {anonymiseAccountData}=await import(mod('lib/accountDataAnonymisation.ts')),{usagePeriodStart}=await import(mod('lib/chatSecurity.ts'));
        await db.$transaction(tx=>anonymiseAccountData(tx,user));await db.user.delete({where:{id:user}});
        const snapshot=await db.codeTaskReservation.findUnique({where:{id:held.reservationId}}),callBefore=await db.codeManagedCall.findUnique({where:{id:req.callId}});
        const where={key_period_periodStart:{key:'provider:openai',period:'provider-cost-day',periodStart:usagePeriodStart('day',callBefore.createdAt)}},providerBefore=await db.chatUsageBucket.findUnique({where});
        await db.codeManagedCall.update({where:{id:req.callId},data:{createdAt:new Date(Date.now()-180000)}});
        await service.reconcileExpiredCodeTasks(new Date(Date.now()+180000));
        assert.equal((await db.codeManagedCall.findUnique({where:{id:req.callId}})).status,'outcome_unknown');
        // Account anonymisation already closes the task; expiry only recovers
        // its pending provider receipt, without reopening or charging it.
        assert.equal((await db.codeTaskReservation.findUnique({where:{id:held.reservationId}})).status,'closed');
        assert.equal((await db.chatUsageBucket.findUnique({where})).count,providerBefore.count);
        const resolved=await reconcile({callId:req.callId,resolutionId:randomUUID(),evidenceRef:'ticket/deleted-dispatched',mode:'no_provider_usage'});
        assert.equal((await db.chatUsageBucket.findUnique({where})).count,providerBefore.count-callBefore.reservedCostMicroUsd);
        assert.equal(await db.user.findUnique({where:{id:user}}),null);assert.equal(await db.creditLot.count({where:{userId:user}}),0);
        assert.deepEqual((await db.codeTaskReservation.findUnique({where:{id:held.reservationId}})).addOnEntries,snapshot.addOnEntries);
        mode='success';pending.splice(0).forEach(r=>r());await late;
        assert.equal((await db.codeManagedCall.findUnique({where:{id:req.callId}})).resolutionAuditId,resolved.auditLogId);
      }finally{mode='success';pending.splice(0).forEach(r=>r());await late;}
    });
    await t.test('migration rejects product spoofing and account anonymisation clears linkage',async()=>{
      const user=await newUser(),held=await reserve(user);await release(user,held.reservationId);
      const {buildAccountDataExport}=await import(mod('lib/accountDataExport.ts'));
      const exported=await buildAccountDataExport(user);assert.equal(exported.data.code_credit_usage.length,1);
      assert.deepEqual(Object.keys(exported.data.code_credit_usage[0]).sort(),['clientTaskId','createdAt','id','releasedCredits','reservedCredits','settledCredits','status','updatedAt']);
      const {anonymiseAccountData}=await import(mod('lib/accountDataAnonymisation.ts'));
      await db.$transaction(tx=>anonymiseAccountData(tx,user));
      const row=await db.codeTaskReservation.findUnique({where:{id:held.reservationId}});assert.equal(row.userId,null);assert.equal(row.subjectKey,'deleted-account');assert.equal(row.requestDigest,'deleted-account');assert.deepEqual(row.addOnEntries,{unlinked:true,credits:0,fundedCostMicroUsd:0});
      // Catch expected violations inside PostgreSQL subtransactions. This also
      // avoids an error-frame recovery defect in the optional local socket shim.
      await db.$executeRaw`DO $$ BEGIN
        BEGIN
          UPDATE "CodeTaskReservation" SET "productKey"='chat' WHERE "id"=(SELECT "id" FROM "CodeTaskReservation" LIMIT 1);
          RAISE EXCEPTION 'Task product CHECK missing';
        EXCEPTION WHEN check_violation THEN NULL; END;
        BEGIN
          UPDATE "CodeManagedCall" SET "productKey"='chat' WHERE "id"=(SELECT "id" FROM "CodeManagedCall" LIMIT 1);
          RAISE EXCEPTION 'Call product CHECK missing';
        EXCEPTION WHEN check_violation THEN NULL; END;
      END $$`;
    });
  }finally{
    pending.splice(0).forEach(resolve=>resolve());await db.$disconnect();await pool.end();
  }
});
