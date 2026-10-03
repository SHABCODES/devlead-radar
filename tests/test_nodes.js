// Unit tests for the Code-node scripts. Run: node --test tests/
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

// Run a node script the way n8n does: $json and $() are injected, the script `return`s.
const { execFileSync } = require('node:child_process');
const ROOT = path.join(__dirname, '..');

// The ICP config is loaded through the same Python loader the builder uses, so tests and builds agree.
function loadIcp(file = 'config/icp.dev-infra.toml') {
  return execFileSync('python', [path.join(ROOT, 'workflows', 'icp_config.py'), path.join(ROOT, file), '--json'], { encoding: 'utf8' }).trim();
}
const DEFAULT_ICP = loadIcp();

// build_workflow.py substitutes __BUILD_*__ placeholders at build time; the tests do the same.
// `opts.now` freezes Date.now()/Date.parse() for scripts that depend on the clock.
function run(file, json, refs = {}, hideKeywordHits = false, opts = {}) {
  const code = fs.readFileSync(path.join(ROOT, 'nodes', file), 'utf8')
    .split('__BUILD_HIDE_KEYWORD_HITS__').join(String(hideKeywordHits))
    .split('__BUILD_ICP_CONFIG__').join(opts.icp || DEFAULT_ICP);
  const $ = (name) => ({ item: { json: refs[name] } });
  const FakeDate = opts.now ? { now: () => opts.now, parse: Date.parse } : Date;
  return new Function('$json', '$', 'Date', code)(json, $, FakeDate).json;
}

const daysAgo = (n) => new Date(Date.now() - n * 864e5).toISOString();
const repo = (o) => ({ fork: false, archived: false, stargazers_count: 0, topics: [], ...o });

test('normalize: cleans URL-style domains and derives github org', () => {
  const r = run('01_normalize.js', { body: { company: 'Fly', domain: 'https://www.Fly.io/pricing?x=1' } });
  assert.equal(r.valid, true);
  assert.equal(r.domain, 'fly.io');
  // No explicit github_org given: github_org is null, hint carries the domain-derived guess.
  assert.equal(r.github_org, null);
  assert.equal(r.github_org_hint, 'fly');
  assert.equal(r.github_org_explicit, false);
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

test('build prompt: keyword_hits are sent by default and removed with the hide flag', () => {
  const s = { ...LEAD, signals: { original_repos: 3, stars_total: 10, keyword_hits: ['container', 'docker'] } };
  assert.ok(run('03_build_prompt.js', s).llm_user.includes('keyword_hits'));
  const hidden = run('03_build_prompt.js', s, {}, true).llm_user;
  assert.ok(!hidden.includes('keyword_hits') && !hidden.includes('docker'));
  assert.ok(hidden.includes('"stars_total": 10'));
});

test('parse: records token usage and model for Groq-style responses', () => {
  const body = JSON.stringify({ score: 4, confidence: 'high', reason: 'r', opener: 'Hi' });
  const r = parse({ model: 'openai/gpt-oss-120b', choices: [{ message: { content: body } }], usage: { prompt_tokens: 812, completion_tokens: 140 } });
  assert.equal(r.llm_tokens_in, 812);
  assert.equal(r.llm_tokens_out, 140);
  assert.equal(r.llm_model, 'openai/gpt-oss-120b');
});

test('parse: records token usage for Claude-style responses and nulls when absent', () => {
  const body = JSON.stringify({ score: 4, confidence: 'high', reason: 'r', opener: 'Hi' });
  const a = parse({ model: 'claude-haiku-4-5-20251001', content: [{ type: 'text', text: body }], usage: { input_tokens: 500, output_tokens: 90 } });
  assert.equal(a.llm_tokens_in, 500);
  assert.equal(a.llm_tokens_out, 90);
  const b = parse(llmReply({ score: 3, confidence: 'low', reason: 'r', opener: 'Hi' }));
  assert.equal(b.llm_tokens_in, null);
});

// ---- Behaviour must not change when settings move into config/*.toml -----------------------------
// tests/golden/pre_config_behavior.json holds inputs and outputs recorded from the scripts as they were
// before the config refactor (with a frozen clock). The default config has to reproduce them exactly.
const golden = JSON.parse(fs.readFileSync(path.join(__dirname, 'golden', 'pre_config_behavior.json'), 'utf8'));
const GLEAD = { company: 'Acme', domain: 'acme.io', github_org: 'acme', source: 't', contact_name: null, contact_email: null, email_freemail: false };

test('golden: rule scores and signals are identical to the pre-config scripts', () => {
  golden.signals.forEach((c, i) => {
    const out = run('02_signals.js', c.input, { 'Normalize & Validate': GLEAD }, false, { now: golden.now });
    assert.deepStrictEqual(out, c.expected, 'signals case ' + i);
  });
});

test('golden: prompts are byte-identical to the pre-config scripts', () => {
  golden.prompts.forEach((c, i) => {
    const out = run('03_build_prompt.js', c.input, {}, c.hide);
    assert.strictEqual(out.llm_system, c.expected.llm_system, 'system prompt case ' + i);
    assert.strictEqual(out.llm_user, c.expected.llm_user, 'user prompt case ' + i);
  });
});

test('golden: parser output is identical apart from the new icp field', () => {
  golden.parse.forEach((c, i) => {
    const { icp, ...rest } = run('04_parse_merge.js', c.reply, { 'Compute Signals': c.compute_signals });
    assert.match(icp, /^dev-infra@[0-9a-f]{8}$/);
    assert.deepStrictEqual(rest, c.expected, 'parse case ' + i);
  });
});

// ---- A different config really does change behaviour ------------------------------------------
const SECURITY_ICP = loadIcp('config/icp.dev-security.toml');

test('config: the example security config changes the prompt, keywords and name', () => {
  const sig = { ...GLEAD, signals: { original_repos: 3, stars_total: 10 } };
  const a = run('03_build_prompt.js', sig);
  const b = run('03_build_prompt.js', sig, {}, false, { icp: SECURITY_ICP });
  assert.notStrictEqual(a.llm_system, b.llm_system);
  assert.ok(b.llm_system.includes('supply-chain security scanner'));
  assert.ok(!b.llm_system.includes('unikernels'));
  const repos = [repo({ name: 'sbom-scanner', description: 'security scanner for devsecops', language: 'Go', stargazers_count: 100, pushed_at: daysAgo(3) })];
  const infra = run('02_signals.js', { statusCode: 200, body: repos }, { 'Normalize & Validate': LEAD });
  const sec = run('02_signals.js', { statusCode: 200, body: repos }, { 'Normalize & Validate': LEAD }, false, { icp: SECURITY_ICP });
  assert.ok(sec.rule_score > infra.rule_score, 'security keywords should score higher under the security config');
  assert.ok(sec.signals.keyword_hits.includes('sbom') && !infra.signals.keyword_hits.includes('sbom'));
});

test('config: hot_threshold and review_gap come from the config', () => {
  const cfg = JSON.parse(DEFAULT_ICP);
  cfg.scoring.hot_threshold = 5;
  cfg.scoring.review_gap = 4;
  const strict = JSON.stringify(cfg);
  const sig = { ...SIG, rule_tier: 1 };
  const reply = llmReply({ score: 4, confidence: 'high', reason: 'r', opener: 'Hi' });
  const dflt = run('04_parse_merge.js', reply, { 'Compute Signals': sig });
  const tuned = run('04_parse_merge.js', reply, { 'Compute Signals': sig }, false, { icp: strict });
  assert.equal(dflt.hot, true);
  assert.equal(dflt.needs_review, true);
  assert.equal(tuned.hot, false);
  assert.equal(tuned.needs_review, false);
});

// In n8n the Scrape Homepage node outputs only the HTTP response ({ body }), not the lead.
// The extractor reads the lead from "Normalize & Validate", so the tests feed it the same way.
const extract = (lead, html) => run('05_extract_github.js', { body: html, statusCode: 200 }, { 'Normalize & Validate': lead });
const L = (company, domain, hint) => ({ company, domain, github_org: null, github_org_hint: hint === undefined ? domain.split('.')[0] : hint, github_org_explicit: false });
const link = (...paths) => '<html><body>' + paths.map((p) => `<a href="https://github.com/${p}">x</a>`).join('') + '</body></html>';

test('extract github: finds most-cited org from homepage HTML and keeps the lead fields', () => {
  const html = `<html><body>
    <a href="https://github.com/weaviate/weaviate">Repo</a>
    <a href="https://github.com/weaviate/docs">Docs</a>
    <a href="https://github.com/login">Login</a>
    <footer>Find us on <a href="https://github.com/weaviate">GitHub</a></footer>
  </body></html>`;
  const out = extract(L('Weaviate', 'weaviate.io'), html);
  assert.equal(out.github_org, 'weaviate');
  assert.equal(out.github_source, 'scraped');
  assert.equal(out.company, 'Weaviate');
  assert.equal(out.domain, 'weaviate.io');
});

test('extract github: falls back to domain hint when no github link found', () => {
  const out = extract(L('Acme Corp', 'acme.com'), '<html><body><p>No code here.</p></body></html>');
  assert.equal(out.github_org, 'acme');
  assert.equal(out.github_source, 'domain_hint');
});

test('extract github: returns null org and unknown source when no link and no hint', () => {
  const out = extract(L('Ghost Corp', 'ghostcorp.biz', null), '<html><body><p>No code here.</p></body></html>');
  assert.equal(out.github_org, null);
  assert.equal(out.github_source, 'unknown');
});

test('extract github: ignores third-party orgs even when they are cited most', () => {
  const html = link('actions/checkout', 'actions/setup-node', 'actions/cache', 'dependabot/dependabot-core', 'noisyco/app');
  const out = extract(L('NoisyCo', 'noisyco.io'), html);
  assert.equal(out.github_org, 'noisyco');
  assert.equal(out.github_source, 'scraped');
});

test('extract github: only third-party links means the domain hint is used, not the third party', () => {
  const out = extract(L('Noisy', 'noisy.io'), link('actions/checkout', 'actions/cache', 'ghostorg'));
  assert.equal(out.github_org, 'noisy');
  assert.equal(out.github_source, 'domain_hint');
});

test('extract github: org names that differ from the domain still match (real-world pairs)', () => {
  const pairs = [['Datadog', 'datadoghq.com', 'DataDog'], ['Cockroach Labs', 'cockroachlabs.com', 'cockroachdb'],
    ['Neon', 'neon.com', 'neondatabase'], ['E2B', 'e2b.dev', 'e2b-dev'], ['Gitpod', 'gitpod.io', 'gitpod-io'],
    ['Redpanda', 'redpanda.com', 'redpanda-data'], ['Turso', 'turso.tech', 'tursodatabase']];
  for (const [co, dom, org] of pairs) {
    const out = extract(L(co, dom), link(`${org}/repo`, 'actions/checkout', 'actions/cache'));
    assert.equal(out.github_org, org.toLowerCase(), `${dom} -> ${org}`);
    assert.equal(out.github_source, 'scraped');
  }
});

test('extract github: look-alike hosts and GitHub-owned paths are not orgs', () => {
  const html = '<a href="https://notgithub.com/fakeco">x</a><a href="https://gist.github.com/fakeco">y</a>' +
               '<a href="https://github.com/features/actions">z</a><a href="https://github.com/sponsors">s</a>';
  const out = extract(L('FakeCo', 'fakeco.io'), html);
  assert.equal(out.github_source, 'domain_hint');
});

test('extract github: finds github.com/orgs/<org> links and www.github.com', () => {
  assert.equal(extract(L('Acme', 'acme.com'), link('orgs/acme/people')).github_org, 'acme');
  assert.equal(extract(L('Acme', 'acme.com'), '<a href="https://www.github.com/acme">x</a>').github_org, 'acme');
});

test('extract github: tolerates a failed fetch (no body)', () => {
  const out = run('05_extract_github.js', { error: { message: 'timeout' } }, { 'Normalize & Validate': L('Acme', 'acme.com') });
  assert.equal(out.github_org, 'acme');
  assert.equal(out.github_source, 'domain_hint');
});
