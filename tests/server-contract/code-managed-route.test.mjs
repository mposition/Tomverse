import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import test,{mock} from 'node:test';
const root=resolve(import.meta.dirname,'../..'),mod=p=>pathToFileURL(resolve(root,p)).href;
let session={user:{id:'synthetic-user'}},serviceCalls=0,failure;
mock.module(mod('lib/prisma.ts'),{namedExports:{prisma:{}}});
mock.module('next-auth/next',{namedExports:{getServerSession:async()=>session}});
mock.module(mod('lib/auth.ts'),{namedExports:{authOptions:{}}});
const {ApiSecurityError}=await import(mod('lib/apiSecurity.ts'));
class CodeManagedError extends ApiSecurityError{
  constructor(status,code,dispatchState='not_dispatched',receipt,metadata){super(status,code,'Fixed Code error.');Object.assign(this,{dispatchState,receipt,metadata});}
}
mock.module(mod('lib/codeManagedService.ts'),{namedExports:{CodeManagedError,handleCodeManaged:async(user,body)=>{
  serviceCalls++;assert.equal(user,'synthetic-user');if(failure)throw failure;return {reservationId:body.reservationId,state:'active',billing:{reservedCredits:10,settledCredits:0,releasedCredits:0,heldCredits:10,unknownHeldCredits:0,availableCredits:10}};
}}});
const {POST}=await import(mod('app/api/code/managed/route.ts'));
const body=()=>({action:'status',reservationId:randomUUID()});
const request=(payload=body(),headers={})=>new Request('https://tomverse.app/api/code/managed',{method:'POST',headers:{origin:'https://tomverse.app','x-tomverse-code':'1','content-type':'application/json',...headers},body:typeof payload==='string'?payload:JSON.stringify(payload)});
test('managed route requires explicit same origin and the native intent header before service work',async()=>{
  const before=serviceCalls;
  for(const headers of [{origin:'https://attacker.example'},{origin:'null'},{origin:''},{'x-tomverse-code':''}]){
    const response=await POST(request(body(),headers));assert.equal(response.status,403);assert.equal((await response.json()).dispatchState,'not_dispatched');
  }
  assert.equal(serviceCalls,before);
});
test('managed route requires the authenticated account and forbids client billing input',async()=>{
  session=null;let response=await POST(request());assert.equal(response.status,401);session={user:{id:'synthetic-user'}};
  const before=serviceCalls;response=await POST(request({...body(),settledCredits:0}));assert.equal(response.status,400);assert.equal(serviceCalls,before);
  response=await POST(request('{malformed-secret-fixture'));assert.equal(response.status,400);assert.equal((await response.text()).includes('secret-fixture'),false);
  response=await POST(request('x'.repeat(1024*1024+1)));assert.equal(response.status,413);assert.equal(serviceCalls,before);
});
test('managed response is private JSON and known paid schema failure preserves only sanitized usage',async()=>{
  let response=await POST(request());assert.equal(response.status,200);assert.equal(response.headers.get('cache-control'),'private, no-store');assert.equal((await response.json()).billing.reservedCredits,10);
  failure=new CodeManagedError(422,'CODE_OUTPUT_INVALID','dispatched',{state:'active',billing:{settledCredits:0}},{usage:{inputTokens:10,outputTokens:3,cachedInputTokens:2,reported:true},latencyMs:5,providerReportedModelId:'fixture'});
  response=await POST(request());const result=await response.json();assert.equal(response.status,422);assert.equal(result.dispatchState,'dispatched');assert.equal(result.usage.inputTokens,10);assert.equal(result.receipt.billing.settledCredits,0);
  failure=new Error('raw credential, prompt and provider body must never leak');response=await POST(request());assert.equal(response.status,503);assert.equal((await response.text()).includes('credential'),false);failure=undefined;
});
