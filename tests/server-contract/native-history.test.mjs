import assert from 'node:assert/strict';
import test, { mock } from 'node:test';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
const mod = path => pathToFileURL(resolve(import.meta.dirname,'../..',path)).href;
let cookies=0,reads=0,owner='another-owner';
mock.module('next-auth/next',{namedExports:{getServerSession:async()=>{cookies++;return{user:{id:'cookie-owner'}};}}});
mock.module(mod('lib/auth.ts'),{namedExports:{authOptions:{}}});
mock.module(mod('lib/mobileAuthRoute.ts'),{namedExports:{mobileAuthRefusal:()=>Response.json({code:'INVALID'},{status:401}),requireMobileBearer:async req=>req.headers.get('authorization')==='Bearer valid'?{ok:true,identity:{userId:'bearer-owner'}}:{ok:false,response:Response.json({code:'INVALID'},{status:401})}}});
mock.module(mod('lib/prisma.ts'),{namedExports:{prisma:{
  user:{findUnique:async({where})=>({id:where.id,accountStatus:'active'})},
  conversation:{findUnique:async()=>{reads++;return{id:'c1',userId:owner,password:'stored',kind:'chat',continuationBridge:null};},findFirst:async({where})=>{reads++;assert.equal(where.userId,'bearer-owner');return null;}},
  conversationProject:{findUnique:async()=>({id:'p1',userId:'another-owner'}),findFirst:async()=>null,updateMany:async({where})=>{assert.equal(where.userId,'bearer-owner');return{count:0};},deleteMany:async({where})=>{assert.equal(where.userId,'bearer-owner');return{count:0};}},
  $queryRaw:async(_strings,...values)=>{reads++;assert.ok(values.includes('bearer-owner'));assert.ok(!values.includes('cookie-owner'));return[];},
}}});
mock.module(mod('lib/apiSecurity.ts'),{namedExports:{apiSecurityResponse:()=>null,consumeApiRateLimit:async(_req,user)=>assert.equal(user,'bearer-owner'),readLimitedJson:async(req,_size,schema)=>schema.parse(await req.json())}});
mock.module(mod('lib/billingEntitlements.ts'),{namedExports:{getUserBillingPlan:async user=>{assert.equal(user,'bearer-owner');return{allowSharing:true,allowDownloads:true};},featureNotIncludedResponse:()=>Response.json({},{status:403}),effectivePlanModelLimit:()=>3,planAllowsFeature:()=>true}});
mock.module(mod('lib/appSettings.ts'),{namedExports:{getOperationalFeatureFlags:async()=>new Proxy({},{get:()=>true}),isMemoryInjectionEnabled:async()=>false,isAssistantProfilesEnabled:async()=>false}});
mock.module(mod('lib/securityAudit.ts'),{namedExports:{logSecurityAuditEvent:()=>{}}});
mock.module(mod('lib/conversationSearch.ts'),{namedExports:{searchConversationMessages:async({userId})=>{reads++;assert.equal(userId,'bearer-owner');return{results:[],truncated:false,sourceSearch:'ok',validUntil:null};}}});
process.env.NEXTAUTH_SECRET='native-history-route-fixture';
const locks=await import('../../lib/conversationLock.ts');
mock.module(mod('lib/conversationLock.ts'),{namedExports:{...locks,consumeLockVerificationAttempt:async()=>({}),clearLockVerificationAttempts:async()=>{},verifyConversationPassword:async()=>({matches:true,needsUpgrade:false})}});
const pin=await import('../../app/api/conversations/[conversationId]/pin/route.ts');
const share=await import('../../app/api/conversations/[conversationId]/share/route.ts');
const exported=await import('../../app/api/conversations/[conversationId]/export/route.ts');
const verify=await import('../../app/api/conversations/[conversationId]/verify/route.ts');
const search=await import('../../app/api/conversations/search/route.ts');
const projects=await import('../../app/api/projects/route.ts');
const project=await import('../../app/api/projects/[projectId]/route.ts');
const conversation=await import('../../app/api/conversations/[conversationId]/route.ts');
const cases=[['/api/conversations/c1/pin','PUT',pin.PUT],['/api/conversations/c1/share','POST',share.POST],['/api/conversations/c1/share','DELETE',share.DELETE],['/api/conversations/c1/export','GET',exported.GET],['/api/conversations/c1/verify','POST',verify.POST],['/api/conversations/search?q=fixture','GET',search.GET],['/api/projects','GET',projects.GET],['/api/projects','POST',projects.POST],['/api/projects/p1','PATCH',project.PATCH],['/api/projects/p1','DELETE',project.DELETE],['/api/conversations/c1','DELETE',conversation.DELETE]];
const context={params:Promise.resolve({conversationId:'c1',projectId:'p1'})};
const request=(path,method,bearer='valid',origin='https://localhost',body={name:'Project',password:'password',pinned:true,seq:Date.now(),ownerId:'bearer-owner'})=>new Request(`https://tomverse.app${path}`,{method,headers:{authorization:`Bearer ${bearer}`,origin,cookie:'another-account','content-type':'application/json'},...(method==='GET'||method==='DELETE'?{}:{body:JSON.stringify(body)})});
test('all history routes refuse inactive rollout, hostile origin and invalid bearer before data work',async()=>{
  process.env.TOMVERSE_NATIVE_CHAT_ENABLED='true';const before=reads;
  for(const[path,method,fn]of cases){delete process.env.TOMVERSE_NATIVE_PARITY_ENABLED;assert.equal((await fn(request(path,method),context)).status,503,`${path} flag`);process.env.TOMVERSE_NATIVE_PARITY_ENABLED='true';assert.equal((await fn(request(path,method,'invalid'),context)).status,401,path);assert.equal((await fn(request(path,method,'valid','https://hostile.invalid'),context)).status,401,path);}
  assert.equal(reads,before);assert.equal(cookies,0);
});
test('history resources enforce bearer ownership even beside a different web cookie',async()=>{
  for(const[path,method,fn]of cases.filter(([path])=>path.includes('/c1/')||path==='/api/conversations/c1'||path==='/api/projects/p1')){
    const response=await fn(request(path,method,'valid','https://localhost',path.endsWith('/pin')?{pinned:true,seq:Date.now(),ownerId:'bearer-owner'}:path.includes('/projects/')?{name:'New name'}:{password:'password'}),context);
    assert.ok([403,404].includes(response.status),`${path}: ${response.status}`);
  }
  assert.equal((await search.GET(request('/api/conversations/search?q=fixture','GET'))).status,200);assert.equal(cookies,0);
});
test('successful native password verification issues an in-memory grant and no browser cookie',async()=>{
  owner='bearer-owner';const response=await verify.POST(request('/api/conversations/c1/verify','POST','valid','https://localhost',{password:'password'}),context);
  assert.equal(response.status,200);assert.equal(response.headers.get('set-cookie'),null);assert.equal(response.headers.get('cache-control'),'no-store');const body=await response.json();assert.equal(typeof body.unlockToken,'string');
  const proof=new Request('https://tomverse.app',{headers:{authorization:'Bearer valid','X-Tomverse-Conversation-Unlocks':`c1=${body.unlockToken}`}});assert.equal(locks.hasConversationUnlockGrant(proof,'bearer-owner','c1','stored'),true);assert.equal(locks.hasConversationUnlockGrant(proof,'cookie-owner','c1','stored'),false);assert.equal(cookies,0);
});
