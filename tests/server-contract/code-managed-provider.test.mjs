import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {randomUUID} from 'node:crypto';
import test,{mock} from 'node:test';
import {createOpenAI} from '@ai-sdk/openai';
import {NoObjectGeneratedError} from 'ai';

const root=resolve(import.meta.dirname,'../..');
const mod=p=>pathToFileURL(resolve(root,p)).href;
let body,fixtureValue,dispatches=0;
const openai=createOpenAI({apiKey:'synthetic-only-never-sent',baseURL:'https://provider.example.test/v1',fetch:async(_url,init)=>{
  dispatches++;body=JSON.parse(init.body);
  return Response.json({id:'resp_fixture',object:'response',created_at:1,status:'completed',model:'provider-reported-fixture',output:[{type:'message',id:'msg_fixture',status:'completed',role:'assistant',content:[{type:'output_text',text:JSON.stringify(fixtureValue),annotations:[]}]}],usage:{input_tokens:100,output_tokens:30,total_tokens:130,input_tokens_details:{cached_tokens:20},output_tokens_details:{reasoning_tokens:25}}});
}});
mock.module(mod('lib/activeAiModel.ts'),{namedExports:{getActiveAiModel:()=>openai('gpt-fixture')}});
const {prepareCodeProvider,normalizedCodeUsage,codeProviderCredentialReady}=await import(mod('lib/codeManagedProvider.ts'));
const fixture=JSON.parse(await readFile(resolve(root,'tests/fixtures/codeManagedSchemas.json'),'utf8'));
const sample=s=>{
  if(s.const!==undefined)return s.const;if(s.enum)return s.enum[0];
  if(s.anyOf)return sample(s.anyOf[0]);if(s.oneOf)return sample(s.oneOf[0]);
  const type=Array.isArray(s.type)?s.type[0]:s.type;
  if(type==='object')return Object.fromEntries((s.required??[]).map(k=>[k,sample(s.properties[k])]));
  if(type==='array')return Array.from({length:s.minItems??0},()=>sample(s.items));
  if(type==='string')return 'x'.repeat(s.minLength??1);if(type==='boolean')return false;if(type==='null')return null;return s.minimum??0;
};
const request=schema=>({action:'complete',reservationId:randomUUID(),callId:randomUUID(),role:'executor',modelId:'gpt-fixture',prompt:{system:'fixture',user:'no project files'},schema,maxOutputTokens:100});
test('real SDK accepts all five Code wire schemas in non-strict mode and validates output locally',async t=>{
  for(const [name,schema]of Object.entries(fixture.schemas))await t.test(name,async()=>{
    fixtureValue=sample(schema);const req=request(schema);const before=dispatches;
    const result=await prepareCodeProvider({provider:'openai'},req)(req);
    assert.equal(dispatches,before+1);assert.equal(result.validOutput,true);
    assert.deepEqual(result.value,fixtureValue);assert.equal(body.text.format.strict,false);
    assert.deepEqual(body.text.format.schema,schema);assert.equal(body.max_output_tokens,100);
    assert.equal(body.tools,undefined);assert.equal(result.providerReportedModelId,'provider-reported-fixture');
    assert.equal(result.usage.cachedInputTokens,20);assert.equal(result.usage.outputTokens,30);assert.equal(result.usage.reasoningTokens,25);
  });
});
test('invalid generated schema retains known normalized usage without returning raw body',async()=>{
  fixtureValue={secretFixture:'not an approved response'};
  const req=request(fixture.schemas.PLAN_SCHEMA);const result=await prepareCodeProvider({provider:'openai'},req)(req);
  assert.equal(result.validOutput,false);assert.equal(result.usage.inputTokens,100);assert.equal(result.usage.cachedInputTokens,20);
  assert.equal(result.usage.reasoningTokens,25);assert.equal(result.value,undefined);
  assert.equal(JSON.stringify(result).includes('secretFixture'),false);
});
test('typed schema failures use the same cache-write/reasoning accounting as success',()=>{
  const usage={inputTokens:100,outputTokens:30,inputTokenDetails:{cacheReadTokens:20,cacheWriteTokens:10},outputTokenDetails:{reasoningTokens:25}};
  const error=new NoObjectGeneratedError({message:'fixture',usage,text:'secret raw body'});
  assert.deepEqual(normalizedCodeUsage(error.usage),{inputTokens:100,outputTokens:30,cachedInputTokens:20,cacheWriteInputTokens:10,reasoningTokens:25,reported:true});
});
test('missing or conflicting credential aliases are pre-dispatch metadata failures',()=>{
  const before=dispatches;assert.equal(codeProviderCredentialReady('google',{}),false);
  assert.equal(codeProviderCredentialReady('google',{GOOGLE_GENERATIVE_AI_API_KEY:'synthetic-a',GEMINI_API_KEY:'synthetic-b'}),false);
  assert.equal(codeProviderCredentialReady('google',{GOOGLE_GENERATIVE_AI_API_KEY:'synthetic-a',GEMINI_API_KEY:'synthetic-a'}),true);
  assert.equal(dispatches,before);
});
