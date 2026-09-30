// Not a unit test: runs the Compute Signals script on real GitHub data.
// Usage: node tests/live_github_check.js superfly vercel walmartlabs
const fs = require('node:fs');
const path = require('node:path');
const code = fs.readFileSync(path.join(__dirname, '..', 'nodes', '02_signals.js'), 'utf8');
(async () => {
  for (const org of process.argv.slice(2)) {
    const r = await fetch(`https://api.github.com/orgs/${org}/repos?per_page=100&sort=pushed&type=public`,
      { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'devlead-radar' } });
    const body = await r.json();
    const $ = () => ({ item: { json: { company: org, domain: org + '.x', github_org: org } } });
    const out = new Function('$json', '$', code)({ statusCode: r.status, body }, $).json;
    console.log(org.padEnd(16), 'http', r.status, out.data_quality.padEnd(12),
      'score', String(out.rule_score).padStart(3), 'tier', out.rule_tier,
      'repos', out.signals.original_repos, 'stars', out.signals.stars_total,
      'kw', out.signals.keyword_hits.join(',') || '-');
  }
})();
