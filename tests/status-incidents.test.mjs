import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeStatusPayload,incidentMatchesScope,fetchStatusSnapshot,STATUS_URLS } from '../lib/status-incidents.js';
import { makePolicy } from './helpers/model-outages.mjs';
import { v2,v2Incident,syntheticCodexIncident,claudeHistoricalReplay,openAIAPIHistoricalReplay,broadCodexHistoricalReplay,
  BROAD_CODEX_WRITEUP_SENTENCE } from './helpers/status-fixtures.mjs';
const policy=makePolicy(), scope=policy.expectedScopePolicies['openai/sol/standard'];
const parsed=p=>normalizeStatusPayload('openai',p,{source:STATUS_URLS.openaiHistory,receivedAt:9000}).incidents[0];
const statusOf=p=>normalizeStatusPayload('openai',p,{source:STATUS_URLS.openaiHistory,receivedAt:9000}).status;

test('synthetic Codex positive is model-specific while API-key and broad auth incidents are negative',()=>{
  assert.equal(incidentMatchesScope(parsed(v2(syntheticCodexIncident())),{aliases:['GPT-6.1 Sol'],scope}),'positive');
  assert.equal(incidentMatchesScope(parsed(openAIAPIHistoricalReplay()),{aliases:['GPT-5.6 Sol'],scope}),'unknown');
  assert.equal(incidentMatchesScope(parsed(broadCodexHistoricalReplay()),{aliases:['GPT-6.1 Sol'],scope}),'unknown');
  const apiScope={...scope,authMode:'api-key',product:'api',transport:'responses'};
  assert.equal(incidentMatchesScope(parsed(openAIAPIHistoricalReplay()),{aliases:['GPT-5.6 Sol'],scope:apiScope}),'positive');
  const excluded=parsed(v2(syntheticCodexIncident({body:'GPT-6.1 Sol API keys are affected; Codex Sign in with ChatGPT is not affected.'})));
  assert.equal(incidentMatchesScope(excluded,{aliases:['GPT-6.1 Sol'],scope}),'unknown');
});
test('broad Codex sign-in write-up wording without a model name stays unknown',()=>{
  // The write-up sentence is placed into the v2 update shape for this test only; in the
  // real feed it is a separate write-up page, not an incident update.
  const broad=parsed(v2(v2Incident({id:'01M3DCNWMW57HYK8FJ5FBFPA39',name:'Issues with Codex',body:BROAD_CODEX_WRITEUP_SENTENCE})));
  assert.equal(incidentMatchesScope(broad,{aliases:['GPT-6.1 Sol'],scope}),'unknown');
});
test('verified Claude historical Opus incident is applicable but resolved history cannot authorize',()=>{
  const cs=policy.expectedScopePolicies['anthropic/opus/standard'];
  const p=normalizeStatusPayload('anthropic',claudeHistoricalReplay(),{source:STATUS_URLS.claude,receivedAt:9000});
  assert.equal(incidentMatchesScope(p.incidents[0],{aliases:['Claude Opus 5.5'],scope:cs}),'positive');
  assert.equal(incidentMatchesScope(p.incidents[0],{aliases:['Claude Opus 5'],scope:cs}),'unknown');
  assert.equal(incidentMatchesScope({...p.incidents[0],resolved:true},{aliases:['Claude Opus 5.5'],scope:cs}),'resolved');
  assert.equal(incidentMatchesScope({...p.incidents[0],id:'978mjkgw6mh7',body:'API requests were not affected.'},{aliases:['Claude Opus 5.5'],scope:cs}),'unknown');
  assert.equal(incidentMatchesScope({...p.incidents[0],id:'978mjkgw6mh7',body:'API requests are not affected'},{aliases:['Claude Opus 5.5'],scope:cs}),'unknown');
});
test('aliases reject unconfigured variant qualifiers and numeric continuations',()=>{
  const cs=policy.expectedScopePolicies['anthropic/opus/standard'];
  const incident=normalizeStatusPayload('anthropic',claudeHistoricalReplay(),{source:STATUS_URLS.claude,receivedAt:9000}).incidents[0];
  const match=(alias,text)=>incidentMatchesScope({...incident,title:`Elevated errors for ${text}`,body:`Requests to ${text} are experiencing elevated errors.`},{aliases:[alias],scope:cs});
  assert.equal(match('Claude Opus 5.5','Claude Opus 5.5 Fast'),'unknown');
  assert.equal(match('Claude Opus 5.5','Claude Opus 5.5-fast'),'unknown');
  assert.equal(match('Claude Opus 5.5','Claude Opus 5.5.'),'positive');
  assert.equal(match('Claude Opus 5.5','Claude Opus 5.5 and Claude Code'),'positive');
  assert.equal(match('Claude Opus 5.5 Fast','Claude Opus 5.5 Fast'),'positive');
  assert.equal(match('Claude Opus 5','Claude Opus 5.5'),'unknown');
  assert.equal(match('GPT-6.1 Sol','GPT-6.1 Sol Instant'),'unknown');
  assert.equal(match('GPT-6.1 Sol','GPT-6.1 Sol-mini'),'unknown');
  const shifted={...incident,body:'Claude Opus 5.5 Fast is experiencing elevated errors on requests.',updatedAt:9001};
  assert.equal(incidentMatchesScope(shifted,{aliases:['Claude Opus 5.5'],scope:cs}),'unknown');
});
test('duplicate incident or update IDs invalidate the entire payload',async()=>{
  const identical=syntheticCodexIncident({id:'duplicate'});
  const conflicting=syntheticCodexIncident({id:'conflict'});
  const duplicateUpdate=syntheticCodexIncident({id:'updates'});
  duplicateUpdate.incident_updates.push({...duplicateUpdate.incident_updates[0],body:'GPT-6.1 Sol in Codex using Sign in with ChatGPT has fully recovered.',status:'resolved'});
  const payloads=[v2(identical,{...identical}),v2(conflicting,{...conflicting,status:'resolved',resolved_at:'2026-10-01T00:02:00Z'}),v2(duplicateUpdate)];
  for(const payload of payloads){
    assert.equal(statusOf(payload),'unknown');
    const snapshot=await fetchStatusSnapshot('openai',{policy,now:()=>9000,fetchImpl:async url=>Response.json(url===STATUS_URLS.openaiWidget?{ongoing_incidents:[]}:payload)});
    assert.equal(snapshot.status,'unknown');
    assert.deepEqual(snapshot.matches,{});
    assert.deepEqual(snapshot.resolvedIncidentIDs,{});
  }
});
test('invalid HTTP responses cancel their bodies before returning an unknown snapshot',async()=>{
  for(const response of [
    {ok:false,headers:new Headers({'content-type':'application/json'})},
    {ok:true,headers:new Headers({'content-type':'text/html'})},
  ]){
    let cancelled=false;
    response.body=new ReadableStream({cancel(){cancelled=true;}});
    const snapshot=await fetchStatusSnapshot('anthropic',{policy,now:()=>9000,fetchImpl:async()=>response});
    assert.equal(cancelled,true);
    assert.equal(snapshot.status,'unknown');
    assert.deepEqual(snapshot.matches,{});
  }
});
test('empty or non-string aliases never match',()=>{
  const i=parsed(v2(syntheticCodexIncident()));
  assert.equal(incidentMatchesScope(i,{aliases:[''],scope}),'unknown');
  assert.equal(incidentMatchesScope(i,{aliases:[],scope}),'unknown');
  assert.equal(incidentMatchesScope(i,{aliases:undefined,scope}),'unknown');
});
test('empty widget still fetches history; receipt freshness and unknown sources are distinct',async()=>{
  const urls=[];
  const snapshot=await fetchStatusSnapshot('openai',{policy,now:()=>9000,fetchImpl:async(url,init)=>{
    urls.push(url);assert.equal(init.redirect,'error');
    return Response.json(url===STATUS_URLS.openaiWidget?{ongoing_incidents:[]}:v2(syntheticCodexIncident()));
  }});
  assert.deepEqual(urls,[STATUS_URLS.openaiWidget,STATUS_URLS.openaiHistory]);
  assert.deepEqual(snapshot.matches['gpt-6-1-sol'],['synthetic-codex']);assert.equal(snapshot.receivedAt,9000);
  assert.equal(normalizeStatusPayload('openai',{ongoing_incidents:[{title:'Codex'}]},{source:STATUS_URLS.openaiWidget,receivedAt:9000}).status,'unknown');
  const bad=await fetchStatusSnapshot('openai',{policy,now:()=>9000,fetchImpl:async()=>new Response('x'.repeat(262145))});
  assert.equal(bad.status,'unknown');assert.deepEqual(bad.matches,{});
});
test('oversized JSON body and a fetch error are unknown, never positive',async()=>{
  // Otherwise-valid v2 payload, ~300 KB, every array/string/depth within bounds: only the
  // aggregate byte budget can reject it.
  const bigPayload=v2(syntheticCodexIncident());bigPayload.page.extra=Array(1000).fill('x'.repeat(300));
  assert.equal(statusOf(bigPayload),'valid');
  const big=JSON.stringify(bigPayload);assert.ok(big.length>262144);
  const over=await fetchStatusSnapshot('openai',{policy,now:()=>9000,fetchImpl:async()=>new Response(big,{headers:{'content-type':'application/json'}})});
  assert.equal(over.status,'unknown');assert.deepEqual(over.matches,{});
  const err=await fetchStatusSnapshot('anthropic',{policy,now:()=>9000,fetchImpl:async()=>{throw new Error('offline');}});
  assert.equal(err.status,'unknown');assert.deepEqual(err.matches,{});
});
test('Claude snapshot fetches only the allowlisted summary URL',async()=>{
  const urls=[];
  const s=await fetchStatusSnapshot('anthropic',{policy,now:()=>9000,fetchImpl:async url=>{urls.push(url);return Response.json(claudeHistoricalReplay());}});
  assert.deepEqual(urls,[STATUS_URLS.claude]);
  assert.equal(s.status,'valid');
  assert.deepEqual(s.matches['claude-opus-5-5'],['ch27pb90bn85']);
  assert.equal(s.matches['gpt-6-1-sol'],undefined);
});
test('latest normalized recovery dominates older title and monitoring alone is insufficient',()=>{
  // u2 is a later EVENT: display_at and created_at both advance (updated_at alone is an edit).
  const i=syntheticCodexIncident();i.incident_updates.push({...i.incident_updates[0],id:'u2',
    display_at:'2026-10-01T00:02:00Z',created_at:'2026-10-01T00:02:00Z',updated_at:'2026-10-01T00:02:00Z',
    body:'GPT-6.1 Sol in Codex using Sign in with ChatGPT has fully recovered. All requests are operating normally.'});
  assert.equal(incidentMatchesScope(parsed(v2(i)),{aliases:['GPT-6.1 Sol'],scope}),'resolved');
  assert.equal(incidentMatchesScope(parsed(v2(syntheticCodexIncident({status:'monitoring',body:'We are monitoring recovery.'}))),{aliases:['GPT-6.1 Sol'],scope}),'unknown');
});
test('event order is display_at then created_at; a later updated_at edit is not a newer event',()=>{
  const recovered='GPT-6.1 Sol in Codex using Sign in with ChatGPT has fully recovered. All requests are operating normally.';
  // An older event edited later must not become the latest update.
  const edited=syntheticCodexIncident();
  edited.incident_updates.unshift({...edited.incident_updates[0],id:'u0',body:recovered,
    display_at:'2026-10-01T00:00:30Z',created_at:'2026-10-01T00:00:30Z',updated_at:'2026-10-01T00:09:00Z'});
  assert.equal(incidentMatchesScope(parsed(v2(edited)),{aliases:['GPT-6.1 Sol'],scope}),'positive');
  // Equal display_at falls through to created_at.
  const byCreated=syntheticCodexIncident();
  byCreated.incident_updates.push({...byCreated.incident_updates[0],id:'u2',body:recovered,created_at:'2026-10-01T00:01:30Z'});
  assert.equal(incidentMatchesScope(parsed(v2(byCreated)),{aliases:['GPT-6.1 Sol'],scope}),'resolved');
  // Equal display_at and created_at with different content is ambiguous: unknown.
  const tie=syntheticCodexIncident();
  tie.incident_updates.push({...tie.incident_updates[0],id:'u2',body:recovered,updated_at:'2026-10-01T00:05:00Z'});
  assert.equal(statusOf(v2(tie)),'unknown');
});
test('active and historical resolved incident IDs remain separate',async()=>{
  const payload=v2(syntheticCodexIncident({id:'active'}),syntheticCodexIncident({id:'old',status:'resolved',resolved_at:'2026-10-01T00:02:00Z'}));
  const snapshot=await fetchStatusSnapshot('openai',{policy,now:()=>9000,fetchImpl:async url=>Response.json(
    url===STATUS_URLS.openaiWidget?{ongoing_incidents:[]}:payload)});
  assert.deepEqual(snapshot.matches['gpt-6-1-sol'],['active']);
  assert.deepEqual(snapshot.resolvedIncidentIDs['gpt-6-1-sol'],['old']);
});
test('missing resolved_at is the active-state compatibility policy; malformed shapes are unknown',()=>{
  const missing=syntheticCodexIncident();delete missing.resolved_at;
  assert.equal(statusOf(v2(missing)),'valid');
  assert.equal(parsed(v2(missing)).resolved,false);
  assert.equal(statusOf(v2(syntheticCodexIncident({resolved_at:'not-a-date'}))),'unknown');
  assert.equal(statusOf(v2(syntheticCodexIncident({components:'Claude API'}))),'unknown');
  assert.equal(statusOf(v2(syntheticCodexIncident({components:[null]}))),'unknown');
  const foreign=syntheticCodexIncident();foreign.incident_updates[0].incident_id='other';
  assert.equal(statusOf(v2(foreign)),'unknown');
  assert.equal(statusOf({incidents:[]}),'unknown');
  assert.equal(statusOf(null),'unknown');
  assert.equal(normalizeStatusPayload('anthropic',claudeHistoricalReplay(),{source:STATUS_URLS.openaiHistory,receivedAt:9000}).status,'unknown');
});
test('item counts, nesting depth and text lengths are bounded and fail closed',()=>{
  const many=v2(...Array.from({length:501},(_,n)=>syntheticCodexIncident({id:`s-${n}`})));
  assert.equal(statusOf(many),'unknown');
  const updates=syntheticCodexIncident();
  for(let n=0;n<200;n++)updates.incident_updates.push({...updates.incident_updates[0],id:`u-${n}`,
    display_at:new Date(Date.parse('2026-10-01T01:00:00Z')+n*1000).toISOString()});
  assert.equal(statusOf(v2(updates)),'unknown');
  let deep={};for(let n=0;n<40;n++)deep={d:deep};
  assert.equal(statusOf({...v2(syntheticCodexIncident()),extra:deep}),'unknown');
  assert.equal(statusOf(v2(syntheticCodexIncident({body:'x'.repeat(20001)}))),'unknown');
  assert.equal(statusOf(v2(syntheticCodexIncident())),'valid');
});
