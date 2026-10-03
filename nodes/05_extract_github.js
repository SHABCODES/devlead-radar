// Extract GitHub Org: runs only when github_org was not given in the request.
// The previous HTTP Request node fetched the company homepage. Its output holds only the
// HTTP response ($json.body), NOT the lead, so the lead is read back from "Normalize & Validate".
//
// We scan the HTML for github.com/<org> links, keep only orgs that look like they belong to
// THIS company (name or domain match), and pick the most cited. A page that links to
// github.com/actions/checkout three times must not make "actions" the lead's org.
// If nothing matches, fall back to the domain-derived hint (source = domain_hint).

const resp = $json;
let lead = {};
try { lead = $('Normalize & Validate').item.json; } catch (e) { lead = {}; }

const html = (typeof resp.body === 'string' ? resp.body : '') +
             (typeof resp.data === 'string' ? resp.data : '');

// Top-level github.com paths that are GitHub's own pages, not organizations.
const RESERVED = new Set(['about', 'advisories', 'apps', 'blog', 'codespaces', 'collections',
  'contact', 'copilot', 'customer-stories', 'discussions', 'enterprise', 'events', 'explore',
  'features', 'github', 'issues', 'join', 'login', 'marketplace', 'mobile', 'new',
  'notifications', 'organizations', 'orgs', 'pricing', 'pulls', 'readme', 'resources',
  'search', 'security', 'sessions', 'settings', 'signup', 'site', 'solutions', 'sponsors',
  'stars', 'team', 'teams', 'topics', 'trending', 'users', 'watching', 'why-github']);

const norm = (x) => String(x || '').toLowerCase().replace(/[^a-z0-9]/g, '');

// Name-like words for this company: the domain's main label and the company name.
function companyLabels(domain, company) {
  const parts = String(domain || '').toLowerCase().replace(/^www\./, '').split('.').filter(Boolean);
  let sld = parts.length >= 2 ? parts[parts.length - 2] : (parts[0] || '');
  if (['co', 'com', 'org', 'net', 'ac', 'gov', 'edu'].includes(sld) && parts.length >= 3) sld = parts[parts.length - 3];
  return [norm(sld), norm(company)].filter((l) => l.length >= 3);
}

function related(org, labels) {
  const o = norm(org);
  return labels.some((l) => {
    if (o.includes(l)) return true;                       // e2b-dev contains e2b
    if (o.length >= 4 && l.includes(o)) return true;      // datadog in datadoghq
    let i = 0;
    while (i < o.length && i < l.length && o[i] === l[i]) i++;
    return i >= 5 && i / Math.min(o.length, l.length) >= 0.6;  // cockroachdb ~ cockroachlabs
  });
}

const ORG = '([a-zA-Z0-9](?:[a-zA-Z0-9-]{0,37}[a-zA-Z0-9])?)';
// (?:^|[^a-zA-Z0-9.-]) keeps out look-alikes such as notgithub.com and gist.github.com.
const PREFIX = '(?:^|[^a-zA-Z0-9.-])(?:www\\.)?github\\.com\\/';
const patterns = [
  new RegExp(PREFIX + '(?:orgs|sponsors)\\/' + ORG, 'g'),  // github.com/orgs/<org>, /sponsors/<org>
  new RegExp(PREFIX + ORG, 'g'),                            // github.com/<org>
];

const counts = {};
for (const re of patterns) {
  let m;
  while ((m = re.exec(html)) !== null) {
    const org = m[1].toLowerCase();
    if (!RESERVED.has(org)) counts[org] = (counts[org] || 0) + 1;
  }
}

const labels = companyLabels(lead.domain, lead.company);
const best = Object.entries(counts)
  .filter(([org]) => related(org, labels))
  .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];
const discovered = best ? best[0] : null;

// Last resort: the domain-derived hint from the normalizer, so we still try the GitHub API.
const hint = lead.github_org_hint || null;
const resolvedOrg = discovered || hint || null;
const resolvedSource = discovered ? 'scraped' : (hint ? 'domain_hint' : 'unknown');

return {
  json: {
    ...lead,
    github_org: resolvedOrg,
    github_source: resolvedSource,
  },
};
