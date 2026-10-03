// Build Prompt: runs once per item. Only leads with real GitHub data get here.
const s = $json;

// Edit this to retarget the scoring. It describes the buyer, not the product pitch.
const ICP = [
  'Unikraft sells a cloud platform built around unikernels: millisecond boot times, high density, low cost per instance.',
  'Good-fit companies build or run infrastructure, developer platforms, serverless or edge compute,',
  'sandboxed code execution (CI, AI agent sandboxes), or any workload where cold starts and compute cost matter.',
  'Poor-fit companies mainly use software rather than build infrastructure (retail, consulting, banks, manufacturers).',
].join(' ');

const system = [
  'You score inbound B2B leads for a sales team. You only use the facts provided.',
  'Never invent products, customers, funding, headcount or numbers that are not in the facts.',
  'Ideal customer profile: ' + ICP,
  'Reply with one JSON object and nothing else, using exactly these keys:',
  '{"score": integer 1-5, "confidence": "low"|"medium"|"high", "reason": string (max 25 words, cite the facts used),',
  '"opener": string (max 30 words, a plain first line for a cold email that references one real fact, no flattery)}',
  'Scale: 1 = clearly not a fit, 3 = unclear, 5 = strong fit with visible infrastructure work.',
].join('\n');

const facts = {
  company: s.company,
  domain: s.domain,
  github_org: s.github_org,
  ...s.signals,
};

return {
  json: {
    ...s,
    llm_request: {
      model: 'claude-3-5-haiku-20241022',
      max_tokens: 400,
      temperature: 0,
      system,
      messages: [{ role: 'user', content: 'Lead facts:\n' + JSON.stringify(facts, null, 2) }],
    },
  },
};
