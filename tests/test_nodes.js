// Unit tests for the Code-node scripts. Run: node --test tests/
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

// Run a node script the way n8n does: $json and $() are injected, the script `return`s.
function run(file, json, refs = {}) {
  const code = fs.readFileSync(path.join(__dirname, '..', 'nodes', file), 'utf8');
  const $ = (name) => ({ item: { json: refs[name] } });
  return new Function('$json', '$', code)(json, $).json;
}

const daysAgo = (n) => new Date(Date.now() - n * 864e5).toISOString();
const repo = (o) => ({ fork: false, archived: false, stargazers_count: 0, topics: [], ...o });

test('normalize: cleans URL-style domains and derives github org', () => {
  const r = run('01_normalize.js', { body: { company: 'Fly', domain: 'https://www.Fly.io/pricing?x=1' } });
  assert.equal(r.valid, true);
  assert.equal(r.domain, 'fly.io');
  assert.equal(r.github_org, 'fly');
});

test('normalize: explicit github_org wins', () => {
  const r = run('01_normalize.js', { body: { company: 'Fly', domain: 'fly.io', github_org: 'SuperFly' } });
  assert.equal(r.github_org, 'superfly');
});

test('normalize: rejects bad domain, missing company, bad email', () => {
  const r = run('01_normalize.js', { body: { domain: 'not a domain', contact_email: 'nope' } });
  assert.equal(r.valid, false);
  assert.ok(r.errors.length >= 3);
});

test('normalize: flags freemail and email/domain mismatch', () => {
  const a = run('01_normalize.js', { body: { company: 'X', domain: 'x.com', contact_email: 'a@gmail.com' } });
  assert.equal(a.email_freemail, true);
  const b = run('01_normalize.js', { body: { company: 'X', domain: 'x.com', contact_email: 'a@mail.x.com' } });
  assert.equal(b.email_domain_match, true);
});

const LEAD = { company: 'Acme', domain: 'acme.io', github_org: 'acme', source: 't' };

test('signals: infra-heavy org gets a high rule tier', () => {
  const body = [
    repo({ name: 'microvm-runtime', description: 'Firecracker based sandbox runtime', language: 'Rust', stargazers_count: 4000, pushed_at: daysAgo(3), topics: ['serverless', 'kubernetes'] }),
    repo({ name: 'edge-proxy', description: 'Cloud edge infrastructure', language: 'Go', stargazers_count: 900, pushed_at: daysAgo(10) }),
    repo({ name: 'cli', description: 'container tooling', language: 'Go', stargazers_count: 300, pushed_at: daysAgo(20) }),
    repo({ name: 'agent', language: 'Rust', stargazers_count: 100, pushed_at: daysAgo(30) }),
    repo({ name: 'ebpf-probe', language: 'C', stargazers_count: 50, pushed_at: daysAgo(40) }),
  ];
  const r = run('02_signals.js', { statusCode: 200, body }, { 'Normalize & Validate': LEAD });
  assert.equal(r.data_quality, 'ok');
  assert.ok(r.rule_tier >= 4, 'tier ' + r.rule_tier + ' score ' + r.rule_score);
  assert.ok(r.signals.keyword_hits.includes('firecracker'));
  assert.equal(r.signals.active_repos_90d, 5);
});

test('signals: forks and archived repos are ignored', () => {
  const body = [repo({ name: 'x', fork: true, stargazers_count: 99999 }), repo({ name: 'y', archived: true })];
  const r = run('02_signals.js', { statusCode: 200, body }, { 'Normalize & Validate': LEAD });
  assert.equal(r.data_quality, 'no_repos');
  assert.equal(r.rule_tier, 1);
});

test('signals: data quality for 404, 403, and transport errors', () => {
  const q = (res) => run('02_signals.js', res, { 'Normalize & Validate': LEAD }).data_quality;
  assert.equal(q({ statusCode: 404, body: {} }), 'no_github');
  assert.equal(q({ statusCode: 403, body: {} }), 'rate_limited');
  assert.equal(q({ error: { message: 'ECONNRESET' } }), 'error');
});

test('signals: "edge" does not match inside "knowledge"', () => {
  const body = [repo({ name: 'kb', description: 'knowledge base', language: 'Python', pushed_at: daysAgo(1) })];
  const r = run('02_signals.js', { statusCode: 200, body }, { 'Normalize & Validate': LEAD });
  assert.ok(!r.signals.keyword_hits.includes('edge'));
});

test('build prompt: provider-neutral system and user text, no invented fields', () => {
  const s = { ...LEAD, signals: { original_repos: 3, stars_total: 10 } };
  const r = run('03_build_prompt.js', s);
  assert.ok(r.llm_system.includes('Never invent'));
  assert.ok(r.llm_user.includes('"stars_total": 10'));
  assert.equal(r.llm_request, undefined);
});

const SIG = { ...LEAD, data_quality: 'ok', rule_tier: 4, rule_score: 60, signals: { stars_total: 4000, original_repos: 5 } };
const llmReply = (obj) => ({ content: [{ type: 'text', text: typeof obj === 'string' ? obj : JSON.stringify(obj) }] });
const parse = (res, sig = SIG) => run('04_parse_merge.js', res, { 'Compute Signals': sig });

test('parse: happy path uses the LLM score', () => {
  const r = parse(llmReply({ score: 5, confidence: 'high', reason: 'Firecracker runtime', opener: 'Saw your microvm-runtime repo.' }));
  assert.equal(r.final_score, 5);
  assert.equal(r.score_source, 'llm');
  assert.equal(r.hot, true);
});

test('parse: handles fenced JSON with chatter around it', () => {
  const r = parse(llmReply('Sure!\n```json\n{"score": 3, "confidence": "medium", "reason": "ok", "opener": "Hi"}\n```'));
  assert.equal(r.llm_score, 3);
});

test('parse: garbage or out-of-range score falls back to rules', () => {
  for (const bad of ['not json', { score: 9, reason: 'x' }, { score: 'abc' }]) {
    const r = parse(llmReply(bad));
    assert.equal(r.score_source, 'rules_fallback');
    assert.equal(r.final_score, 4);
    assert.equal(r.llm_status, 'parse_error');
  }
});

test('parse: API error object falls back to rules and says why', () => {
  const r = parse({ error: { message: 'overloaded' } });
  assert.equal(r.llm_status, 'api_error');
  assert.equal(r.final_score, 4);
});

test('parse: opener with an ungrounded number is dropped', () => {
  const r = parse(llmReply({ score: 4, confidence: 'high', reason: 'r', opener: 'Congrats on your 12,000 stars!' }));
  assert.equal(r.opener, null);
  assert.equal(r.opener_dropped, true);
});

test('parse: opener with a grounded number is kept', () => {
  const r = parse(llmReply({ score: 4, confidence: 'high', reason: 'r', opener: 'Your 4000 stars caught my eye.' }));
  assert.ok(r.opener);
});

test('parse: big LLM vs rules gap sets needs_review', () => {
  const r = parse(llmReply({ score: 1, confidence: 'high', reason: 'r', opener: 'Hi' }));
  assert.equal(r.needs_review, true);
});

test('parse: skipped LLM statuses map to the right lead status', () => {
  const skip = (dq) => run('04_parse_merge.js', { ...SIG }, { 'Compute Signals': { ...SIG, data_quality: dq } });
  assert.equal(skip('no_github').status, 'no_github_data');
  assert.equal(skip('rate_limited').status, 'needs_retry');
  assert.equal(skip('rate_limited').final_score, null);
});

test('parse: reads Groq / OpenAI-style responses', () => {
  const groq = { choices: [{ message: { role: 'assistant', content: JSON.stringify({ score: 5, confidence: 'high', reason: 'r', opener: 'Hi' }) } }] };
  const r = parse(groq);
  assert.equal(r.llm_status, 'ok');
  assert.equal(r.final_score, 5);
});

test('parse: api error gives a short single-line llm_error', () => {
  const r = parse({ error: { message: 'Rate limit\nreached ' + 'x'.repeat(500) } });
  assert.equal(r.llm_status, 'api_error');
  assert.ok(r.llm_error.length <= 200 && !r.llm_error.includes('\n'));
});

test('parse: parse_error records finish_reason and a text snippet for debugging', () => {
  const r = parse({ choices: [{ finish_reason: 'length', message: { content: '' } }] });
  assert.equal(r.llm_status, 'parse_error');
  assert.ok(r.llm_error.includes('finish_reason=length'));
});
