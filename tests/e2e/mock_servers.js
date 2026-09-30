// Mock GitHub (port 9001) and Anthropic (port 9002) so the workflow can be tested end to end
// without keys or network. Orgs: infraco, retailco, ghost (404), limited (403), garbagellm, llmdown.
const http = require('node:http');
const daysAgo = (n) => new Date(Date.now() - n * 864e5).toISOString();
const R = (o) => ({ fork: false, archived: false, topics: [], ...o });
const infra = [
  R({ name: 'microvm-runtime', description: 'Firecracker based sandbox runtime', language: 'Rust', stargazers_count: 4000, pushed_at: daysAgo(2), topics: ['serverless'] }),
  R({ name: 'edge-proxy', description: 'Cloud edge infrastructure', language: 'Go', stargazers_count: 900, pushed_at: daysAgo(9) }),
  R({ name: 'k8s-operator', description: 'kubernetes container operator', language: 'Go', stargazers_count: 300, pushed_at: daysAgo(15) }),
];
const retail = [R({ name: 'storefront-theme', description: 'Website theme', language: 'JavaScript', stargazers_count: 12, pushed_at: daysAgo(200) })];

http.createServer((req, res) => {
  const m = req.url.match(/^\/orgs\/([^/]+)\/repos/);
  const org = m && m[1];
  const send = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
  if (org === 'ghost') return send(404, { message: 'Not Found' });
  if (org === 'limited') return send(403, { message: 'API rate limit exceeded' });
  if (org === 'retailco') return send(200, retail);
  return send(200, infra);
}).listen(9001);

http.createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', () => {
    const send = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
    const body = JSON.parse(raw || '{}');
    const openai = req.url.startsWith('/openai/');
    const content = body.messages[body.messages.length - 1].content;
    if (content.includes('"github_org": "llmdown"')) return send(500, { error: { message: 'boom' } });
    const text = (t) => send(200, openai
      ? { choices: [{ message: { role: 'assistant', content: t } }] }
      : { content: [{ type: 'text', text: t }] });
    if (content.includes('"github_org": "garbagellm"')) return text('I cannot help with that.');
    const facts = JSON.parse(content.slice(content.indexOf('{')));
    const good = facts.stars_total > 1000;
    text('```json\n' + JSON.stringify({
      score: good ? 5 : 1, confidence: 'high',
      reason: good ? 'Firecracker sandbox runtime and edge infra repos, actively pushed.' : 'Only a website theme repo.',
      opener: good ? 'Your microvm-runtime repo caught my eye.' : 'Hi there.',
    }) + '\n```');
  });
}).listen(9002);
console.log('mocks up');
