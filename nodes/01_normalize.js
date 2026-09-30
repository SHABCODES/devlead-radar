// Normalize & Validate: runs once per item.
// Input: the raw webhook payload. Output: a clean lead plus a `valid` flag.
const FREEMAIL = new Set([
  'gmail.com', 'yahoo.com', 'outlook.com', 'hotmail.com',
  'proton.me', 'protonmail.com', 'icloud.com', 'aol.com',
]);
const body = $json.body || $json;
const str = (v) => (typeof v === 'string' ? v.trim() : '');
const errors = [];

const company = str(body.company);
if (!company) errors.push('company is required');

// "https://www.Fly.io/pricing?x=1" -> "fly.io"
const domain = str(body.domain)
  .toLowerCase()
  .replace(/^https?:\/\//, '')
  .replace(/^www\./, '')
  .split('/')[0]
  .split('?')[0];
if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(domain)) {
  errors.push('domain is missing or not a valid hostname');
}

// GitHub org: explicit value wins, otherwise the first label of the domain.
let githubOrg = str(body.github_org).toLowerCase();
if (!githubOrg && domain) githubOrg = domain.split('.')[0];
if (!/^[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?$/.test(githubOrg)) {
  errors.push('could not derive a valid GitHub org name');
}

// Email is optional, but if present it has to look real.
const email = str(body.contact_email).toLowerCase();
let emailFreemail = false;
let emailDomainMatch = null;
if (email) {
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    errors.push('contact_email is not a valid address');
  } else {
    const emailDomain = email.split('@')[1];
    emailFreemail = FREEMAIL.has(emailDomain);
    emailDomainMatch = emailDomain === domain || emailDomain.endsWith('.' + domain);
  }
}

return {
  json: {
    valid: errors.length === 0,
    errors,
    company,
    domain,
    github_org: githubOrg,
    contact_name: str(body.contact_name) || null,
    contact_email: email || null,
    source: str(body.source) || 'unknown',
    email_freemail: emailFreemail,
    email_domain_match: emailDomainMatch,
    received_at: new Date().toISOString(),
  },
};
