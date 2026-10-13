// Official status-page evidence for model outage reserves.
//
// Reads ONLY the allowlisted official JSON feeds below, normalizes them against verified
// Statuspage v2 shapes, and decides conservatively whether an incident applies to one
// configured primary model on one expected route (auth mode, product, transport).
//
// Fail-closed rules (see the approved design, section 4 and section 11):
//   - Any unknown source, malformed shape, oversized payload, too many items, too-deep
//     nesting, or over-long text makes the WHOLE payload 'unknown'. Unknown carries no
//     positive authority.
//   - Only exact configured incident aliases match, with token boundaries ('Claude Opus 5'
//     never matches 'Claude Opus 5.5'). No family/version guessing.
//   - The latest update is chosen by EVENT time: display_at, then created_at. updated_at is
//     an edit of an existing update, not a new event. Conflicting ties are 'unknown'.
//   - An explicit exclusion in the latest update dominates the title; a resolved current
//     state overrides older scope; monitoring alone is not degradation.
//   - Absence of an incident from bounded history is never proof of health: no resolution
//     is ever emitted for an incident that is simply missing.
//   - Incidents are never merged: each incident is matched on its own title and its own
//     latest update only.
// No XML/Atom parsing, no incident-link following, no credential or prompt input.

export const STATUS_URLS = Object.freeze({
  claude: 'https://status.claude.com/api/v2/summary.json',
  openaiWidget: 'https://status.openai.com/api/v1/summary',
  openaiHistory: 'https://status.openai.com/api/v2/incidents.json',
});

// Bounds. Exceeding any of them makes the payload unknown (fail closed), never truncated.
export const STATUS_LIMITS = Object.freeze({
  bytes: 262144,        // aggregate response bytes per snapshot (all requests together)
  timeoutMs: 5000,      // one wall-clock deadline per snapshot
  depth: 16,            // JSON nesting depth
  arrayItems: 1000,     // any array anywhere in the payload
  incidents: 500,
  updatesPerIncident: 200,
  componentsPerIncident: 200,
  stringChars: 20000,   // any single string value or key
});

const str = (x) => typeof x === 'string' && x.length > 0;
const date = (x) => str(x) && Number.isFinite(Date.parse(x));
const obj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);

// Iterative walk so a hostile payload cannot exhaust the stack.
function withinBounds(root) {
  const stack = [[root, 0]];
  while (stack.length) {
    const [value, depth] = stack.pop();
    if (typeof value === 'string') { if (value.length > STATUS_LIMITS.stringChars) return false; continue; }
    if (value === null || typeof value !== 'object') continue;
    if (depth >= STATUS_LIMITS.depth) return false;
    if (Array.isArray(value)) {
      if (value.length > STATUS_LIMITS.arrayItems) return false;
      for (const v of value) stack.push([v, depth + 1]);
    } else {
      for (const [k, v] of Object.entries(value)) {
        if (k.length > STATUS_LIMITS.stringChars) return false;
        stack.push([v, depth + 1]);
      }
    }
  }
  return true;
}

// Event order: display_at, then created_at (newest first). updated_at is deliberately ignored.
function eventOrder(a, b) {
  return (Date.parse(b.display_at) - Date.parse(a.display_at)) || (Date.parse(b.created_at) - Date.parse(a.created_at));
}

export function normalizeStatusPayload(providerID, p, { source, receivedAt }) {
  const unknown = { status: 'unknown', receivedAt, incidents: [] };
  if (!withinBounds(p)) return unknown;
  if (providerID === 'openai' && source === STATUS_URLS.openaiWidget) {
    // Only the EMPTY widget shape is verified. A nonempty widget's schema is not, so it is
    // unknown rather than interpreted.
    return Array.isArray(p?.ongoing_incidents) && p.ongoing_incidents.length === 0
      ? { status: 'valid', receivedAt, incidents: [] } : unknown;
  }
  const expectedSource = providerID === 'anthropic' ? STATUS_URLS.claude
    : providerID === 'openai' ? STATUS_URLS.openaiHistory : null;
  if (!expectedSource || source !== expectedSource) return unknown;
  if (!obj(p) || !obj(p.page) || !['id', 'name', 'url'].every((k) => str(p.page[k])) || !date(p.page.updated_at)
    || !Array.isArray(p.incidents) || p.incidents.length > STATUS_LIMITS.incidents) return unknown;
  const incidents = [];
  const incidentIDs = new Set();
  for (const i of p.incidents) {
    if (!obj(i) || !['id', 'name', 'status'].every((k) => str(i[k])) || !date(i.created_at) || !date(i.updated_at)
      || !Array.isArray(i.incident_updates) || i.incident_updates.length > STATUS_LIMITS.updatesPerIncident) return unknown;
    if (incidentIDs.has(i.id)) return unknown;
    incidentIDs.add(i.id);
    if (providerID === 'openai' && (!str(i.impact) || !str(i.page_id))) return unknown;
    // Compatibility policy, not observed data: every captured OpenAI incident was resolved,
    // so a null or missing resolved_at is treated as "not resolved". A present value must
    // be a valid date.
    if (i.resolved_at != null && !date(i.resolved_at)) return unknown;
    const updateIDs = new Set();
    for (const u of i.incident_updates) {
      if (!obj(u) || !['id', 'body', 'status', 'incident_id'].every((k) => str(u[k])) || u.incident_id !== i.id
        || !['created_at', 'display_at', 'updated_at'].every((k) => date(u[k]))) return unknown;
      if (updateIDs.has(u.id)) return unknown;
      updateIDs.add(u.id);
    }
    const latest = [...i.incident_updates].sort(eventOrder);
    // Equally-latest events with different content are ambiguous, not a reason to pick one.
    if (latest[1] && eventOrder(latest[0], latest[1]) === 0
      && (latest[0].body !== latest[1].body || latest[0].status !== latest[1].status)) return unknown;
    if (i.components != null && (!Array.isArray(i.components) || i.components.length > STATUS_LIMITS.componentsPerIncident
      || !i.components.every((c) => obj(c) && str(c.name)))) return unknown;
    const components = i.components ?? [];
    // Only a component that is itself model-named (and named in the title) can prove that
    // model recovered; whole-provider components never do.
    const modelComponents = components.filter((c) => /\b(?:opus|sonnet|fable|sol)\b/i.test(c.name)
      && i.name.toLowerCase().includes(c.name.toLowerCase()));
    incidents.push({
      id: i.id, title: i.name, body: latest[0]?.body ?? '', status: i.status,
      resolved: i.status === 'resolved' || latest[0]?.status === 'resolved' || i.resolved_at != null,
      componentRecovered: modelComponents.length > 0 && modelComponents.every((c) => c.status === 'operational'),
      components: components.map((c) => c.name), updatedAt: Date.parse(i.updated_at),
    });
  }
  return { status: 'valid', receivedAt, incidents };
}

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// Token-bounded exact alias: not preceded by [a-z0-9], not followed by [a-z0-9], '.<digit>',
// a hyphenated continuation, or an unconfigured model variant qualifier.
const aliasPattern = (a) => new RegExp(`(^|[^a-z0-9])${escape(a.toLowerCase())}(?!(?:[\\s-]+)(?:fast|ultrafast|mini|nano|instant|turbo|pro|max|lite|flash|thinking|preview|sol|luna|terra|astra)\\b|[a-z0-9]|[.]\\d|-[a-z0-9])`);

export function incidentMatchesScope(i, { aliases, scope }) {
  if (!obj(i) || !obj(scope) || typeof i.title !== 'string' || typeof i.body !== 'string') return 'unknown';
  // An empty alias would match every incident; only non-empty strings are aliases.
  const patterns = (Array.isArray(aliases) ? aliases : []).filter(str).map(aliasPattern);
  const latest = i.body.toLowerCase(), all = `${i.title}\n${i.body}`.toLowerCase();
  if (!patterns.some((re) => re.test(all))) return 'unknown';
  // The latest update naming some model but not ours moved the scope away from ours.
  const latestNamesModel = /\bclaude (?:opus|sonnet|fable) \d|\bgpt-\d/.test(latest);
  if (latestNamesModel && !patterns.some((re) => re.test(latest))) return 'unknown';
  const recovery = /fully recovered|all requests are operating normally|issue (?:is |has been )?resolved/.test(latest);
  const excluded = /not affected|unaffected|no impact/.test(latest);
  const claude = scope.providerID === 'anthropic' && scope.authMode === 'claude-code-oauth'
    && scope.product === 'claude-code' && scope.transport === 'messages';
  const codex = scope.providerID === 'openai' && scope.authMode === 'chatgpt-oauth'
    && scope.product === 'codex' && scope.transport === 'responses';
  const api = scope.providerID === 'openai' && scope.authMode === 'api-key'
    && scope.product === 'api' && ['responses', 'chat'].includes(scope.transport);
  const components = Array.isArray(i.components) ? i.components : [];
  const applicable = claude ? (components.some((c) => /^claude (api|code)$/i.test(c)) && /requests|api|claude code/.test(all))
    : codex ? /\bcodex\b/.test(all) && /\bsign in with chatgpt\b|\bchatgpt sign.in\b|\bchatgpt oauth\b/.test(all)
    : api ? /\bapi\b/.test(all) && /responses|chat completions/.test(all) : false;
  if (!applicable) return 'unknown';
  if (i.resolved === true || i.componentRecovered === true || recovery) return 'resolved';
  if (excluded || !['investigating', 'identified', 'monitoring'].includes(i.status)) return 'unknown';
  return /elevated (?:service )?errors|service (?:errors|unavailable)|requests? (?:are )?failing|overload|authentication (?:errors|failures)|login (?:errors|failures)|sign.in (?:errors|failures)/.test(latest)
    ? 'positive' : 'unknown';
}

// One snapshot per provider. fetchImpl is injectable so tests never touch the network.
// receivedAt is the validation time of this fetch, never an incident edit time.
export async function fetchStatusSnapshot(providerID, { fetchImpl = fetch, now = Date.now, signal, policy }) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), STATUS_LIMITS.timeoutMs);
  const abortSignal = AbortSignal.any([controller.signal, ...(signal ? [signal] : [])]);
  let remaining = STATUS_LIMITS.bytes;
  const urls = providerID === 'anthropic' ? [STATUS_URLS.claude]
    : providerID === 'openai' ? [STATUS_URLS.openaiWidget, STATUS_URLS.openaiHistory] : [];
  const normalized = [];
  try {
    if (!urls.length) throw new Error('unknown provider');
    for (const url of urls) {
      const r = await fetchImpl(url, { signal: abortSignal, redirect: 'error', headers: { accept: 'application/json' } });
      if (!r.ok || !(r.headers.get('content-type') ?? '').includes('application/json') || !r.body) {
        if (r.body) await r.body.cancel();
        throw new Error('invalid status source');
      }
      const reader = r.body.getReader(), chunks = [];
      let ended = false;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) { ended = true; break; }
          remaining -= value.byteLength;
          if (remaining < 0) throw new Error('status size');
          chunks.push(Buffer.from(value));
        }
      } finally {
        try { if (!ended) await reader.cancel(); } finally { reader.releaseLock(); }
      }
      normalized.push(normalizeStatusPayload(providerID, JSON.parse(Buffer.concat(chunks).toString('utf8')), { source: url, receivedAt: now() }));
    }
    // v2 history is independently verified even when the widget is unknown; the widget
    // contributes no incidents either way.
    const authoritative = normalized.at(-1);
    if (authoritative.status !== 'valid') throw new Error('unknown history');
    const matches = {}, authMatches = {}, resolvedIncidentIDs = {}, resolved = [];
    for (const [primary, logicalID] of Object.entries(policy.primaryScope)) {
      const scope = policy.expectedScopePolicies[logicalID];
      if (!scope || scope.providerID !== providerID) continue;
      const states = authoritative.incidents.map((i) => [i.id, incidentMatchesScope(i, { aliases: policy.incidentAliases[primary], scope })]);
      const positive = states.filter(([, s]) => s === 'positive').map(([id]) => id);
      if (positive.length) matches[primary] = positive;
      const recovered = states.filter(([, s]) => s === 'resolved').map(([id]) => id);
      if (recovered.length) resolvedIncidentIDs[primary] = recovered;
      // Diagnostic only: an episode closes only on resolution of its own known incident ID.
      if (!positive.length && recovered.length) resolved.push(primary);
      const auth = authoritative.incidents.filter((i) => positive.includes(i.id)
        && /authentication (?:errors|failures)|login (?:errors|failures)|sign.in (?:errors|failures)|\b401\b/i.test(i.body)).map((i) => i.id);
      if (auth.length) authMatches[primary] = auth;
    }
    return { type: 'snapshot', providerID, status: 'valid', receivedAt: now(), matches, authMatches, resolved,
      resolvedIncidentIDs, sourceIncidentIDs: authoritative.incidents.map((i) => i.id) };
  } catch {
    // Every failure (network, size, parse, schema) is an unknown snapshot with no authority.
    if (!controller.signal.aborted) controller.abort();
    return { type: 'snapshot', providerID, status: 'unknown', receivedAt: now(), matches: {}, authMatches: {},
      resolved: [], resolvedIncidentIDs: {}, reason: signal?.aborted ? 'cancelled' : 'invalid-source' };
  } finally {
    clearTimeout(timeoutId);
  }
}
