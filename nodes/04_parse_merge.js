// Parse & Merge: runs once per item. Combines the LLM answer with the rule score
// and never lets a bad model response break the pipeline.
const s = $('Compute Signals').item.json;
const res = $json;

function extractJson(text) {
  if (typeof text !== 'string') return null;
  const t = text.replace(/```(?:json)?/gi, '');
  const a = t.indexOf('{');
  const b = t.lastIndexOf('}');
  if (a === -1 || b <= a) return null;
  try { return JSON.parse(t.slice(a, b + 1)); } catch (e) { return null; }
}

function validate(o) {
  if (!o || typeof o !== 'object') return null;
  const score = Math.round(Number(o.score));
  if (!Number.isFinite(score) || score < 1 || score > 5) return null;
  const confidence = ['low', 'medium', 'high'].includes(o.confidence) ? o.confidence : 'low';
  const reason = typeof o.reason === 'string' ? o.reason.trim().slice(0, 300) : '';
  let opener = typeof o.opener === 'string' ? o.opener.trim().slice(0, 300) : '';
  // Grounding check: every number in the opener must appear in the facts we sent.
  const factsText = JSON.stringify(s.signals);
  const numbers = opener.match(/\d[\d,.]*/g) || [];
  const grounded = numbers.every((n) => factsText.includes(n.replace(/[.,]$/, '')));
  if (!grounded) opener = '';
  return { score, confidence, reason, opener: opener || null, opener_dropped: !grounded };
}

let llm = null;
let llmStatus = 'skipped';
let parseHint = '';
if (s.data_quality === 'ok') {
  // Groq / OpenAI-style: choices[0].message.content. Claude: content[0].text.
  const text =
    (res && res.choices && res.choices[0] && res.choices[0].message && res.choices[0].message.content) ||
    (res && res.content && res.content[0] && res.content[0].text) ||
    '';
  llm = validate(extractJson(text));
  const fin = res && res.choices && res.choices[0] && res.choices[0].finish_reason;
  parseHint = 'finish_reason=' + (fin || 'n/a') + ' text=' + String(text).slice(0, 120);
  if (llm) llmStatus = 'ok';
  else if (res && (res.error || res.type === 'error')) llmStatus = 'api_error';
  else llmStatus = 'parse_error';
}

// Short, single-line error text for debugging. Never stored in the database.
let llmError = null;
if (llmStatus === 'api_error') {
  const e = res.error;
  const msg = (e && (e.message || (typeof e === 'string' ? e : ''))) || res.message || 'unknown error';
  llmError = String(msg).replace(/\s+/g, ' ').slice(0, 200);
} else if (llmStatus === 'parse_error') {
  llmError = parseHint.replace(/\s+/g, ' ').slice(0, 200);
}

let status;
let finalScore = null;
let scoreSource = null;
if (s.data_quality === 'ok') {
  status = 'scored';
  finalScore = llm ? llm.score : s.rule_tier;
  scoreSource = llm ? 'llm' : 'rules_fallback';
} else if (s.data_quality === 'no_github' || s.data_quality === 'no_repos') {
  status = 'no_github_data';
} else {
  status = 'needs_retry';
}

const needsReview = !!llm && Math.abs(llm.score - s.rule_tier) >= 2;

return {
  json: {
    company: s.company,
    domain: s.domain,
    github_org: s.github_org,
    contact_name: s.contact_name,
    contact_email: s.contact_email,
    source: s.source,
    email_freemail: s.email_freemail,
    status,
    final_score: finalScore,
    score_source: scoreSource,
    llm_status: llmStatus,
    llm_error: llmError,
    llm_score: llm ? llm.score : null,
    llm_confidence: llm ? llm.confidence : null,
    reason: llm ? llm.reason : null,
    opener: llm ? llm.opener : null,
    opener_dropped: llm ? llm.opener_dropped : false,
    rule_score: s.rule_score,
    rule_tier: s.rule_tier,
    needs_review: needsReview,
    hot: finalScore !== null && finalScore >= 4,
    signals: s.signals,
  },
};
