import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import test,{mock} from 'node:test';
const root=resolve(import.meta.dirname,'../..'),mod=p=>pathToFileURL(resolve(root,p)).href;
Object.assign(process.env,{ADMIN_EMAILS:'owner@example.invalid,billing@example.invalid',ADMIN_OWNER_EMAILS:'owner@example.invalid',ADMIN_BILLING_EMAILS:'billing@example.invalid',ADMIN_USER_IDS:'',ADMIN_ACCESS_EXPIRY_JSON:'{}',ADMIN_RECENT_AUTH_MINUTES:'15',CODE_MANAGED_RECONCILIATION_ENABLED:'true'});
const owner=()=>({user:{id:'synthetic-owner',email:'owner@example.invalid',authenticatedAt:new Date().toISOString()}});
let session=owner(),serviceCalls=0,rateCalls=0;
mock.module(mod('lib/prisma.ts'),{namedExports:{prisma:{}}});
mock.module('next-auth/next',{namedExports:{getServerSession:async()=>session}});
mock.module(mod('lib/auth.ts'),{namedExports:{authOptions:{}}});
const actual=await import(mod('lib/apiSecurity.ts'));
mock.module(mod('lib/apiSecurity.ts'),{namedExports:{ApiSecurityError:actual.ApiSecurityError,readLimitedJson:actual.readLimitedJson,consumeApiRateLimit:async()=>{rateCalls++;}}});
class CodeManagedError extends actual.ApiSecurityError{}
mock.module(mod('lib/codeManagedService.ts'),{namedExports:{CodeManagedError,reconcileCodeManagedCall:async(_session,_request,body)=>{serviceCalls++;return {callId:body.callId,resolutionId:body.resolutionId,state:'resolved',customerChargeCredits:0};}}});
const {POST}=await import(mod('app/api/admin/code/managed-reconciliation/route.ts'));
const body=()=>({callId:randomUUID(),resolutionId:randomUUID(),evidenceRef:'ticket/fixture-only',mode:'no_provider_usage'});
const request=(payload=body(),headers={})=>new Request('https://tomverse.app/api/admin/code/managed-reconciliation',{method:'POST',headers:{origin:'https://tomverse.app','content-type':'application/json',...headers},body:typeof payload==='string'?payload:JSON.stringify(payload)});
test('reconciliation route requires a same-origin authenticated owner and recent authentication',async()=>{
  const before=serviceCalls;let response=await POST(request(body(),{origin:'https://attacker.example'}));assert.equal(response.status,403);
  session=null;response=await POST(request());assert.equal(response.status,404);
  session={user:{...owner().user,email:'billing@example.invalid'}};response=await POST(request());assert.equal(response.status,404);
  session={user:{...owner().user,authenticatedAt:new Date(Date.now()-3600000).toISOString()}};response=await POST(request());assert.equal(response.status,428);assert.equal((await response.json()).error,'CODE_ADMIN_REAUTH_REQUIRED');
  session=owner();assert.equal(serviceCalls,before);assert.equal(rateCalls,0);
});
test('reconciliation is separately default-off before rate or monetary work',async()=>{
  process.env.CODE_MANAGED_RECONCILIATION_ENABLED='false';const response=await POST(request());assert.equal(response.status,503);assert.equal(serviceCalls,0);assert.equal(rateCalls,0);process.env.CODE_MANAGED_RECONCILIATION_ENABLED='true';
});
test('reconciliation accepts only bounded evidence/usage metadata and no claimed money or provider endpoint',async()=>{
  for(const payload of [{...body(),actualCostMicroUsd:0},{...body(),url:'https://attacker.example'},{...body(),evidenceRef:'ticket?secret=value'},{...body(),evidenceRef:'https://host/path'},{...body(),mode:'known_usage',usage:{inputTokens:-1,outputTokens:1}}])assert.equal((await POST(request(payload))).status,400);
  const response=await POST(request('secret fixture '.repeat(1000)));assert.equal(response.status,413);assert.equal((await response.text()).includes('secret fixture'),false);assert.equal(serviceCalls,0);
});
test('owner reconciliation is private, rate-limited and cannot charge a customer',async()=>{
  const response=await POST(request());assert.equal(response.status,200);assert.equal(response.headers.get('cache-control'),'private, no-store');assert.equal((await response.json()).customerChargeCredits,0);assert.equal(serviceCalls,1);assert.ok(rateCalls>0);
});
