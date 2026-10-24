import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
const mod=path=>pathToFileURL(resolve(import.meta.dirname,"../..",path)).href;
let refusal=false;const queries=[];
mock.module(mod("lib/chatRouteSession.ts"),{namedExports:{resolveChatRouteSession:async()=>refusal?{response:Response.json({code:"REFUSED"},{status:401})}:{session:{user:{id:"bearer-owner"}}}}});
mock.module(mod("lib/prisma.ts"),{namedExports:{prisma:{imageGenerationGroup:{findUnique:async query=>{queries.push(query);const key=query.where.userId_groupIdempotencyKey;assert.equal(key.userId,"bearer-owner");return key.groupIdempotencyKey==="owned-key"?{id:"group",conversationId:"studio"}:null;}}}}});
mock.module(mod("lib/apiSecurity.ts"),{namedExports:{consumeApiRateLimit:async()=>{},apiSecurityResponse:()=>null,readLimitedJson:async()=>{throw Error("No mutation");}}});
mock.module(mod("lib/imageGenerationService.ts"),{namedExports:{requestImageGeneration:async()=>{throw Error("Must never execute");},processImageGenerationGroup:async()=>{throw Error("Must never execute");}}});
mock.module(mod("lib/chatSecurity.ts"),{namedExports:{ChatAccessError:class extends Error{},chatErrorResponse:()=>null}});
const {GET}=await import("../../app/api/images/generations/route.ts");
test("receipt recovery is owner-scoped, read-only and never returns storage identities",async()=>{
 const result=await GET(new Request("https://tomverse.app/api/images/generations?requestKey=owned-key"));assert.equal(result.status,200);assert.deepEqual(await result.json(),{groupId:"group",conversationId:"studio"});assert.equal(result.headers.get("cache-control"),"no-store");
 const foreign=await GET(new Request("https://tomverse.app/api/images/generations?requestKey=foreign-key"));assert.equal(foreign.status,404);
});
test("refused credentials and invalid keys stop before the receipt lookup",async()=>{
 const before=queries.length;refusal=true;assert.equal((await GET(new Request("https://tomverse.app/api/images/generations?requestKey=owned-key"))).status,401);refusal=false;assert.equal((await GET(new Request("https://tomverse.app/api/images/generations?requestKey=short"))).status,400);assert.equal(queries.length,before);
});
