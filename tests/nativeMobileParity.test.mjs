import assert from "node:assert/strict";
import test from "node:test";
import { createApiTransport } from "../apps/mobile/src/apiTransport.ts";
import { nativeParityBearerRoute } from "../lib/nativeBearerGate.ts";
import { validateMobileUpload } from "../apps/mobile/src/nativeUpload.ts";
import { deviceAccessGrant } from "../apps/mobile/src/deviceUnlock.ts";
const bridge = { hasSession: async () => ({ signedIn: true }), signOut: async () => {} };
const capability = { reviewEasy: true, assistants: true, maxModels: 3, plan: "Max" };

test("a native lock waits before HTTP dispatch and only resumes after native unlock", async () => {
  let locked = true; let grants = 0; const events = new EventTarget();
  const bridge = { getAccessToken: async () => { grants++; if (locked) throw { code: "DEVICE_LOCKED" }; return { accessToken: "synthetic", expiresAt: Date.now()+600000 }; }, getDeviceSecurity: async () => ({ locked, enabled: true, available: true }) };
  let sent = false;
  const pending = deviceAccessGrant(bridge, {}, undefined, events).then(() => { sent = true; });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(sent, false); assert.equal(grants, 1);
  events.dispatchEvent(new Event("tomverse-device-unlocked")); await new Promise(resolve => setImmediate(resolve)); assert.equal(sent, false);
  locked = false; events.dispatchEvent(new Event("tomverse-device-unlocked")); await pending; assert.equal(sent,true); assert.equal(grants,2);
});
test("aborting while locally locked never requests a second grant", async () => {
  let grants = 0; const events = new EventTarget(); const controller = new AbortController();
  const pending = deviceAccessGrant({ getAccessToken: async () => { grants++; throw {code:"DEVICE_LOCKED"}; }, getDeviceSecurity: async () => ({locked:true,enabled:true,available:true}) }, {}, controller.signal, events);
  await new Promise(resolve => setImmediate(resolve)); controller.abort(); await assert.rejects(pending, {name:"AbortError"}); events.dispatchEvent(new Event("tomverse-device-unlocked")); assert.equal(grants,1);
});

test("parity enrollment is default-off and never includes adjacent administrative or publishing operations", () => {
  const allowed = [["/api/products/mobile/capabilities", "GET"], ["/api/user/settings", "POST"], ["/api/memories/settings", "PUT"], ["/api/images/groups/g1", "GET"], ["/api/images/generations", "POST"], ["/api/conversations/c1/comparison-reviews", "POST"], ["/api/conversations/c1/comparison-reviews/item-feedback", "DELETE"]];
  for (const [path, method] of allowed) { assert.equal(nativeParityBearerRoute(path, method), false); assert.equal(nativeParityBearerRoute(path, method, true), true); }
  for (const [path, method] of [["/api/admin/users", "GET"], ["/api/user/settings/extra", "POST"], ["/api/assistant-profiles", "POST"], ["/api/conversations/c1/share", "POST"], ["/api/images/groups/g1", "DELETE"], ["/api/conversations/%2Fadmin/comparison-reviews", "POST"]]) assert.equal(nativeParityBearerRoute(path, method, true), false);
});
test("legacy servers never receive cookie-only parity requests or invalidate a valid mobile session", async () => {
  const calls = []; let lost = 0;
  const transport = createApiTransport(async path => { calls.push(path); return Response.json({ code: "NOT_FOUND" }, { status: 404 }); }, bridge);
  transport.onSessionLost(() => lost++);
  await assert.rejects(transport.preferences()); await assert.rejects(transport.imageGroup("group-a"));
  assert.deepEqual(calls, ["/api/products/mobile/capabilities", "/api/products/mobile/capabilities"]); assert.equal(lost, 0);
});
test("capability reads coalesce and reject invalid limits before exposing privileged controls", async () => {
  let count = 0;
  const transport = createApiTransport(async () => { count++; return Response.json(capability); }, bridge);
  const [a,b] = await Promise.all([transport.mobileCapabilities(), transport.mobileCapabilities()]); assert.deepEqual(a,b); assert.equal(count,1);
  await transport.mobileCapabilities(true); assert.equal(count,2);
  const invalid = createApiTransport(async () => Response.json({ ...capability, maxModels: 100 }), bridge);
  await assert.rejects(invalid.mobileCapabilities(), /NATIVE_CAPABILITIES_INVALID/);
});
test("selected image bytes pass through native upload and return an opaque completed receipt", async () => {
  const order = []; const file = new File([new Uint8Array([137,80,78,71])], "test.png", { type: "image/png" });
  const transport = createApiTransport(async (path, init) => {
    order.push(init.method); assert.equal(path,"/api/chat"); const body=JSON.parse(init.body);
    if(init.method==="PUT") return Response.json({ key:"private/input", uploadUrl:"https://fixture.r2.cloudflarestorage.com/bucket/a?X-Amz-Signature=synthetic", uploadHeaders:{"Content-Type":"image/png"} });
    assert.equal(body.key,"private/input"); return Response.json({ uploadId:"receipt", name:file.name, mediaType:"image/png", size:4, key:"must-not-return" });
  }, bridge, async()=>{}, async(url, headers, selected)=>{ order.push("NATIVE_BYTES"); validateMobileUpload(url,headers); assert.deepEqual([...new Uint8Array(await selected.arrayBuffer())],[137,80,78,71]); assert.equal(headers.Authorization,undefined); });
  const result = await transport.upload(file); assert.deepEqual(order,["PUT","NATIVE_BYTES","PATCH"]); assert.deepEqual(result,{uploadId:"receipt",name:"test.png",mediaType:"image/png",size:4});
});
test("a failed storage upload never commits a completed receipt", async () => {
  const calls=[]; const transport=createApiTransport(async(path,init)=>{calls.push(init.method);return Response.json({key:"k",uploadUrl:"https://fixture.r2.cloudflarestorage.com/a?X-Amz-Signature=s",uploadHeaders:{}});},bridge,async()=>{},async()=>{throw Error("Upload failed");});
  await assert.rejects(transport.upload(new File(["x"],"x.png",{type:"image/png"})));assert.deepEqual(calls,["PUT"]);
});
test("native upload destination and credential headers are fail-closed", () => {
  const valid="https://fixture.r2.cloudflarestorage.com/a?X-Amz-Signature=synthetic";
  assert.doesNotThrow(()=>validateMobileUpload(valid,{"Content-Type":"image/png"}));
  for(const url of ["http://fixture.r2.cloudflarestorage.com/a?X-Amz-Signature=s", "https://evil.invalid/a?X-Amz-Signature=s", "https://fixture.r2.cloudflarestorage.com.evil.invalid/a?X-Amz-Signature=s", "https://user@fixture.r2.cloudflarestorage.com/a?X-Amz-Signature=s", "https://fixture.r2.cloudflarestorage.com/a", valid+"#fragment"]) assert.throws(()=>validateMobileUpload(url,{}));
  for(const headers of [{Authorization:"Bearer secret"},{Cookie:"a=b"},{"Content-Type":"image/png\r\nx: injected"}])assert.throws(()=>validateMobileUpload(valid,headers));
});
test("Review saves a question once and isolates each model's follow-up context", async () => {
  const calls=[];const conversation={id:"review-a",selectedModels:["a","b"],messages:[{id:"old-user",role:"user",content:"Previous"},{id:"a-old",role:"assistant",modelId:"a",content:"A previous"},{id:"b-old",role:"assistant",modelId:"b",content:"B previous"}],webSearchMode:"always"};
  const transport=createApiTransport(async(path,init={})=>{
    calls.push({path,init});
    if(path.endsWith("/messages")){const input=JSON.parse(init.body).messages[0];conversation.messages.push({id:"saved",role:"user",content:input.content});return Response.json({messageMappings:[{requestId:input.clientRequestId,messageId:"saved"}]});}
    if(path==="/api/chat"){const body=JSON.parse(init.body);assert.equal(body.sourceUserMessageId,"saved");assert.equal(body.webSearchMode,"always");assert.ok(!body.messages.some(message=>message.content===(body.modelId==="a"?"B previous":"A previous")));conversation.messages.push({id:body.assistantMessageId,role:"assistant",modelId:body.modelId,content:"Done",status:"normal"});return new Response("Done");}
    return Response.json(conversation);
  },bridge);
  const result=await transport.sendReview(conversation,"Follow-up",[],new AbortController().signal,()=>{});
  assert.deepEqual(result.failedModelIds,[]);assert.equal(calls.filter(call=>call.path.endsWith("/messages")).length,1);assert.equal(calls.filter(call=>call.path==="/api/chat").length,2);
});

test("restore reads every message page and restores the canonical assistant profile", async () => {
  const calls=[];const transport=createApiTransport(async path=>{calls.push(path);return Response.json({id:"c",selectedModels:["a"],assistantProfile:{profileId:"owned-profile"},messages:[{id:path.includes("cursor")?"last":"first",role:"user",content:"Saved"}],messagePage:path.includes("cursor")?{hasMore:false,nextCursor:null}:{hasMore:true,nextCursor:"first"}});},bridge);
  const item=await transport.load("c");assert.deepEqual(item.messages.map(message=>message.id),["first","last"]);assert.equal(item.assistantProfileId,"owned-profile");assert.deepEqual(calls,["/api/conversations/c","/api/conversations/c?cursor=first"]);
});
test("Deep Research uses its durable job status without submitting a second question or model request", async () => {
  const calls=[];const conversation={id:"research",selectedModels:["research-model"],messages:[]};
  const transport=createApiTransport(async(path,init={})=>{
    calls.push(path);
    if(path==="/api/products/mobile/capabilities")return Response.json(capability);
    if(path.endsWith("/messages")){const message=JSON.parse(init.body).messages[0];conversation.messages.push({id:"source",role:"user",content:message.content});return Response.json({messageMappings:[{requestId:message.clientRequestId,messageId:"source"}]});}
    if(path==="/api/chat"){const input=JSON.parse(init.body);conversation.messages.push({id:input.assistantMessageId,role:"assistant",modelId:input.modelId,status:"pending",pendingJobId:"provider-job",content:""});return Response.json({deepResearchJobId:input.assistantMessageId,status:"submitted"},{headers:{"X-Chat-Response-Mode":"async-job"}});}
    if(path==="/api/chat/deep-research/status"){conversation.messages.at(-1).status="normal";conversation.messages.at(-1).content="Finished research";return Response.json({status:"completed",content:"Finished research"});}
    return Response.json(conversation);
  },bridge);
  const progress=[];await transport.send(conversation,"Research",[],new AbortController().signal,value=>progress.push(value));
  assert.equal(progress.at(-1),"Finished research");assert.equal(calls.filter(path=>path==="/api/chat").length,1);assert.equal(calls.filter(path=>path.endsWith("/messages")).length,1);assert.equal(calls.filter(path=>path==="/api/chat/deep-research/status").length,1);
});
