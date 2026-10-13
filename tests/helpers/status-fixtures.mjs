// Status-page fixtures for lib/status-incidents.js. Offline only: nothing here is a raw
// vendor capture, and no fixture is (or may be presented as) a live incident.
//
// Provenance labels:
//   - SYNTHETIC: invented to exercise a branch no real incident has exercised yet. No real
//     model-specific Codex incident exists, so the positive Codex OAuth branch is tested
//     ONLY with the SYNTHETIC fixture below.
//   - HISTORICAL REPLAY: the incident ID, name and update wording are quoted from a
//     verified official incident; the status lifecycle, timestamps, page object and
//     components are fixture values placed into the verified Statuspage v2 shape.
//
// Shape: the verified OpenAI v2 incidents.json shape
//   {page:{id,name,url,updated_at}, incidents:[{id,name,status,created_at,updated_at,
//    resolved_at,impact,page_id,incident_updates:[{id,body,created_at,display_at,
//    incident_id,status,updated_at}]}]}
// Claude's summary.json carries the same incident/update keys (Statuspage v2).

// Shape builder. Its defaults ARE the synthetic Codex incident; use
// syntheticCodexIncident() at call sites so the provenance stays visible in tests.
export function v2Incident({id='synthetic-codex',name='Elevated errors for GPT-6.1 Sol in Codex',
  body='Requests to GPT-6.1 Sol using Codex Sign in with ChatGPT are experiencing elevated service errors.',
  status='investigating',resolved_at=null,components=[]}={}) {
  return {id,name,status,created_at:'2026-10-01T00:00:00Z',updated_at:'2026-10-01T00:01:00Z',
    resolved_at,impact:'major',page_id:'page-fixture',components,
    incident_updates:[{id:`${id}-u`,body,created_at:'2026-10-01T00:01:00Z',display_at:'2026-10-01T00:01:00Z',
      incident_id:id,status,updated_at:'2026-10-01T00:01:00Z'}]};
}

// SYNTHETIC: a model-specific Codex Sign in with ChatGPT incident. Not captured data --
// no such official incident has been observed. Exists only to prove the positive branch.
export const syntheticCodexIncident = (overrides = {}) => v2Incident(overrides);

export const v2 = (...incidents) => ({page:{id:'page-fixture',name:'fixture',url:'https://status.openai.com',updated_at:'2026-10-01T00:01:00Z'},incidents});

// HISTORICAL REPLAY of Claude incident ch27pb90bn85 (resolved in reality; replayed here
// in an active lifecycle to test applicability -- never asserted to be live).
// Name and investigating body quoted verbatim. Components are fixture values.
export const claudeHistoricalReplay = () => v2(v2Incident({id:'ch27pb90bn85',
  name:'Elevated errors for Claude Opus 5.5',
  body:'We are investigating elevated errors on requests to Claude Opus 5.5. We will provide an update as soon as possible.',
  components:[{name:'Claude API',status:'degraded_performance'},{name:'Claude Code',status:'degraded_performance'}]}));

// HISTORICAL REPLAY of OpenAI incident 01M27VK1VN54RQJGJEHB5JTQJJ (public API path).
// Every captured OpenAI incident was resolved; the active lifecycle is a fixture value.
export const openAIAPIHistoricalReplay = () => v2(v2Incident({id:'01M27VK1VN54RQJGJEHB5JTQJJ',
  name:'Elevated errors for GPT-5.6 Sol on the API',
  body:'We have brought additional capacity online and are seeing improvements for some GPT-5.6 Sol API traffic. We continue to mitigate elevated errors affecting Chat Completions and Responses and are monitoring recovery'}));

// HISTORICAL REPLAY of OpenAI incident 01M3DCNWMW57HYK8FJ5FBFPA39 'Issues with Codex'.
// Broad and model-unspecified: it must never authorize an older-model reserve.
export const broadCodexHistoricalReplay = () => v2(v2Incident({id:'01M3DCNWMW57HYK8FJ5FBFPA39',name:'Issues with Codex',body:'Login via API key will unblock access at this time.'}));

// Quoted sentence from the 01M3DCNWMW57HYK8FJ5FBFPA39 write-up page. The write-up is NOT an
// incident update in the v2 feed; tests that place it into the update shape say so.
export const BROAD_CODEX_WRITEUP_SENTENCE = 'Users accessing Codex through Sign in with ChatGPT experienced authentication errors (401) and gateway errors (502).';
