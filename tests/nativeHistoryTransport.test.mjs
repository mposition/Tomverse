import assert from 'node:assert/strict';
import test from 'node:test';
import { createApiTransport } from '../apps/mobile/src/apiTransport.ts';
import { nativeParityBearerRoute } from '../lib/nativeBearerGate.ts';
import { createConversationUnlockCookie, hasConversationUnlockGrant, hasResourceUnlockGrant } from '../lib/conversationLock.ts';
const bridge = { signOut: async () => {} };
const capability = { reviewEasy: true, assistants: true, maxModels: 3, plan: 'Max', historyActions: true };
process.env.NEXTAUTH_SECRET ||= 'native-history-test-secret';

test('history enrollment is exact, method-bounded and default-off', () => {
  for (const [path, method] of [['/api/conversations/search','GET'], ['/api/projects','POST'], ['/api/projects/project-a','DELETE'], ['/api/conversations/c','DELETE'], ['/api/conversations/c/pin','PUT'], ['/api/conversations/c/share','POST'], ['/api/conversations/c/share','DELETE'], ['/api/conversations/c/export','GET'], ['/api/conversations/c/verify','POST']]) {
    assert.equal(nativeParityBearerRoute(path,method),false); assert.equal(nativeParityBearerRoute(path,method,true),true);
  }
  for(const [path,method] of [['/api/conversations/export-all','GET'],['/api/conversations','DELETE'],['/api/projects/id/admin','GET'],['/api/conversations/c/share','GET'],['/api/conversations/c/verify','GET'],['/api/conversations/%2Fother/share','POST']])assert.equal(nativeParityBearerRoute(path,method,true),false);
});
test('old servers receive no history writes or searches and do not destroy a valid login', async()=>{
  const calls=[];let lost=0;const transport=createApiTransport(async path=>{calls.push(path);return Response.json({...capability,historyActions:false});},bridge);transport.onSessionLost(()=>lost++);
  await assert.rejects(transport.history.remove('c'), /NATIVE_HISTORY_UNAVAILABLE/);await assert.rejects(transport.history.search('query',new AbortController().signal));
  assert.deepEqual(calls,['/api/products/mobile/capabilities']);assert.equal(lost,0);
});
test('native unlocks remain owner, conversation, password and resource-bound; bearer never borrows cookies',()=>{
  const cookie=createConversationUnlockCookie('owner','c','stored-hash');const token=cookie.split(';')[0].split('=')[1];
  const headers={authorization:'Bearer fixture','X-Tomverse-Conversation-Unlocks':`c=${token}`};const request=new Request('https://tomverse.app/api/conversations/c',{headers});
  assert.equal(hasConversationUnlockGrant(request,'owner','c','stored-hash'),true);
  for(const [owner,id,password] of [['other','c','stored-hash'],['owner','other','stored-hash'],['owner','c','new-hash']])assert.equal(hasConversationUnlockGrant(request,owner,id,password),false);
  assert.equal(hasResourceUnlockGrant('external',request,'owner','c','stored-hash'),false);
  assert.equal(hasConversationUnlockGrant(new Request('https://tomverse.app',{headers:{authorization:'Bearer fixture',cookie}}),'owner','c','stored-hash'),false);
  assert.equal(hasConversationUnlockGrant(new Request('https://tomverse.app',{headers:{'X-Tomverse-Conversation-Unlocks':`c=${token}`}}),'owner','c','stored-hash'),false);
  assert.equal(hasConversationUnlockGrant(new Request('https://tomverse.app',{headers:{...headers,'X-Tomverse-Conversation-Unlocks':'x'.repeat(8193)}}),'owner','c','stored-hash'),false);
});
test('proof is sent only to conversation APIs and is cleared before logout',async()=>{
  const token=`${Math.floor(Date.now()/1000)+600}.fingerprint.signature`;const calls=[];
  const transport=createApiTransport(async(path,init={})=>{calls.push({path,headers:new Headers(init.headers)});if(path.includes('/capabilities'))return Response.json(capability);if(path.endsWith('/verify'))return Response.json({unlockToken:token});if(path==='/api/conversations')return Response.json([]);if(path==='/api/projects')return Response.json({projects:[]});return Response.json({results:[]});},bridge);
  await transport.history.unlock('c','input-password');assert.equal(transport.history.unlocked('c'),true);
  await transport.history.search('query',new AbortController().signal);assert.equal(calls.at(-1).headers.get('X-Tomverse-Conversation-Unlocks'),`c=${token}`);
  await transport.history.projects();assert.equal(calls.at(-1).headers.has('X-Tomverse-Conversation-Unlocks'),false);
  await transport.signOut();assert.equal(transport.history.unlocked('c'),false);await transport.list();assert.equal(calls.at(-1).headers.has('X-Tomverse-Conversation-Unlocks'),false);
});
test('an in-flight proof cannot repopulate grants after logout',async()=>{
  let resolve;const pending=new Promise(r=>resolve=r);const transport=createApiTransport(async path=>path.endsWith('/verify')?pending:Response.json(capability),bridge);
  const login=transport.history.unlock('c','password');await new Promise(r=>setImmediate(r));await transport.signOut();resolve(Response.json({unlockToken:`${Math.floor(Date.now()/1000)+600}.fingerprint.signature`}));
  await assert.rejects(login,/SIGN_IN_REQUIRED/);assert.equal(transport.history.unlocked('c'),false);
});
test('pin writes preserve identity and monotonic ordering; source export uses the canonical query',async()=>{
  const writes=[];let saved;
  const transport=createApiTransport(async(path,init={})=>{if(path.includes('/capabilities'))return Response.json(capability);if(path==='/api/user/account')return Response.json({id:'owner'});if(path.endsWith('/pin'))writes.push(JSON.parse(init.body));if(path.includes('/export')){assert.equal(path,'/api/conversations/c/export?include=source');return new Response('Original and continuation');}return Response.json({});},bridge,async response=>{saved=await response.text();});
  await transport.history.pin({id:'c',title:'Title',pinSeq:Date.now()+100},true);await transport.history.pin({id:'c',title:'Title'},false);assert.equal(writes[0].ownerId,'owner');assert.ok(writes[1].seq>writes[0].seq);assert.equal(writes[1].pinned,false);
  await transport.history.export('c','Title',true);assert.equal(saved,'Original and continuation');
});
