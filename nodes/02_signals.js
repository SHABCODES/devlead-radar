// Compute Signals: runs once per item, after the GitHub HTTP call.
// Turns the raw repo list into a few facts and a deterministic baseline score.
const lead = $('Normalize & Validate').item.json;
const res = $json;

// --- ICP config: edit this block to retarget the whole pipeline -------------
const KEYWORDS = {
  unikernel: 15, hypervisor: 10, microvm: 12, firecracker: 12,
  serverless: 8, wasm: 8, webassembly: 8, sandbox: 6, paas: 6, ebpf: 6,
  kubernetes: 6, k8s: 6, container: 5, docker: 4, runtime: 4,
  edge: 4, infrastructure: 4, cloud: 3, observability: 3, rust: 3,
};
const LANGUAGES = { Rust: 6, Go: 6, C: 6, 'C++': 5, Zig: 4, TypeScript: 2, Python: 2 };
const TIER_CUTOFFS = [10, 25, 45, 65]; // rule_score below each cutoff -> tier 1..4, else 5
// -----------------------------------------------------------------------------

const status = typeof res.statusCode === 'number' ? res.statusCode : 0;
const repos = status === 200 && Array.isArray(res.body) ? res.body : [];
const own = repos.filter((r) => !r.fork && !r.archived);

let dataQuality;
if (status === 200) dataQuality = own.length > 0 ? 'ok' : 'no_repos';
else if (status === 404) dataQuality = 'no_github';
else if (status === 403 || status === 429) dataQuality = 'rate_limited';
else dataQuality = 'error';

const cutoff = Date.now() - 90 * 24 * 3600 * 1000;
const active90 = own.filter((r) => r.pushed_at && Date.parse(r.pushed_at) >= cutoff);
const starsTotal = own.reduce((n, r) => n + (r.stargazers_count || 0), 0);

const langCount = {};
for (const r of own) if (r.language) langCount[r.language] = (langCount[r.language] || 0) + 1;
const topLanguages = Object.entries(langCount)
  .sort((a, b) => b[1] - a[1])
  .slice(0, 3)
  .map(([name]) => name);

const text = own
  .map((r) => [r.name, r.description || '', ...(r.topics || [])].join(' '))
  .join(' ')
  .toLowerCase();
const keywordHits = Object.keys(KEYWORDS).filter((k) =>
  new RegExp('\\b' + k + 's?\\b').test(text));

const topRepos = [...own]
  .sort((a, b) => (b.stargazers_count || 0) - (a.stargazers_count || 0))
  .slice(0, 3)
  .map((r) => ({
    name: r.name,
    stars: r.stargazers_count || 0,
    description: (r.description || '').slice(0, 120),
  }));

const activityPts = Math.min(25, active90.length * 5);
const keywordPts = Math.min(40, keywordHits.reduce((n, k) => n + KEYWORDS[k], 0));
const languagePts = Math.min(15, topLanguages.reduce((n, l) => n + (LANGUAGES[l] || 0), 0));
const tractionPts = Math.min(20, Math.round(Math.log10(starsTotal + 1) * 5));
const ruleScore = dataQuality === 'ok' ? activityPts + keywordPts + languagePts + tractionPts : 0;
const ruleTier = TIER_CUTOFFS.filter((c) => ruleScore >= c).length + 1;

return {
  json: {
    ...lead,
    github_status: status,
    data_quality: dataQuality,
    signals: {
      original_repos: own.length,
      active_repos_90d: active90.length,
      stars_total: starsTotal,
      top_languages: topLanguages,
      keyword_hits: keywordHits,
      top_repos: topRepos,
    },
    rule_breakdown: { activityPts, keywordPts, languagePts, tractionPts },
    rule_score: ruleScore,
    rule_tier: ruleTier,
  },
};
