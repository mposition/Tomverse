import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import test from 'node:test';
import {codeManagedRequestSchema,codeManagedEnabled,codeCallCeiling,codeBilling,codeSchemaAndPrompt,validCodeUsage} from '../lib/codeManagedCore.ts';

const request=()=>({action:'complete',reservationId:randomUUID(),callId:randomUUID(),role:'executor',modelId:'fixture',prompt:{system:'safe',user:'fixture'},schema:{type:'object',properties:{ok:{type:'boolean'}},required:['ok'],additionalProperties:false},maxOutputTokens:100});
const model={capabilities:{maxOutputTokens:1000,maxContextTokens:10000}};
test('managed execution is explicitly off and derived guardrails cannot be lowered',()=>{
  assert.equal(codeManagedEnabled({}),false);assert.equal(codeManagedEnabled({CODE_MANAGED_EXECUTION_ENABLED:'TRUE'}),false);
  assert.equal(codeManagedEnabled({CODE_MANAGED_EXECUTION_ENABLED:'true'}),true);
  assert.equal(codeCallCeiling({CODE_TASK_CALL_CEILING:'1'}),408);assert.equal(codeCallCeiling({CODE_TASK_CALL_CEILING:'500'}),500);
});
test('strict action contract rejects client usage, endpoints, credits and malformed IDs',()=>{
  assert.equal(codeManagedRequestSchema.safeParse(request()).success,true);
  for(const extra of [{usage:{inputTokens:0}},{url:'https://example.test'},{settledCredits:0}])assert.equal(codeManagedRequestSchema.safeParse({...request(),...extra}).success,false);
  assert.equal(codeManagedRequestSchema.safeParse({...request(),callId:'not-uuid'}).success,false);
  assert.equal(codeManagedRequestSchema.safeParse({...request(),maxOutputTokens:0}).success,false);
});
test('schema and prompt limits reject remote references, executable patterns and excess output',()=>{
  assert.doesNotThrow(()=>codeSchemaAndPrompt(request(),model));
  assert.doesNotThrow(()=>codeSchemaAndPrompt({...request(),schema:{type:'object',properties:{pattern:{type:'string'},format:{type:'string'},patternProperties:{type:'object'}},required:['format']}},model));
  for(const schema of [{type:'object',$ref:'https://example.test'},{type:'object',properties:{x:{type:'string',pattern:'(a+)+$'}}},{type:'array'},{type:'object',description:'x'.repeat(65536)}])assert.throws(()=>codeSchemaAndPrompt({...request(),schema},model));
  assert.throws(()=>codeSchemaAndPrompt({...request(),maxOutputTokens:1001},model));
  assert.throws(()=>codeSchemaAndPrompt({...request(),prompt:{system:'x',user:'한'.repeat(3000)}},model));
});
test('billing distinguishes active, unknown, settled and released credits',()=>{
  assert.deepEqual(codeBilling({reservedCredits:20,settledCredits:3,releasedCredits:2},[{status:'dispatched',reservedCredits:4},{status:'outcome_unknown',reservedCredits:5}]),{reservedCredits:20,settledCredits:3,releasedCredits:2,heldCredits:15,unknownHeldCredits:5,availableCredits:6});
  assert.throws(()=>codeBilling({reservedCredits:2,settledCredits:1,releasedCredits:0},[{status:'outcome_unknown',reservedCredits:2}]));
  assert.deepEqual(Object.keys(codeBilling({reservedCredits:2,settledCredits:0,releasedCredits:0,requestDigest:'internal',reservedCostMicroUsd:123n},[])).sort(),['availableCredits','heldCredits','releasedCredits','reservedCredits','settledCredits','unknownHeldCredits']);
});
test('provider-normalized reasoning is counted once and malformed usage is rejected',()=>{
  assert.deepEqual(validCodeUsage({inputTokens:100,outputTokens:30,cachedInputTokens:20,cacheWriteInputTokens:10,reasoningTokens:25}),{inputTokens:100,outputTokens:30,cachedInputTokens:20,cacheWriteInputTokens:10,reasoningTokens:25,reported:true});
  for(const usage of [undefined,{inputTokens:-1,outputTokens:1},{inputTokens:1,outputTokens:Infinity},{inputTokens:2,outputTokens:1,reasoningTokens:2},{inputTokens:2,outputTokens:1,cachedInputTokens:2,cacheWriteInputTokens:1}])assert.equal(validCodeUsage(usage),null);
});
