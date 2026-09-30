#!/usr/bin/env python3
"""Send edge-case leads to a running n8n (mocked workflow) and assert on the responses."""
import json, sys, urllib.request, urllib.error
URL = sys.argv[1] if len(sys.argv) > 1 else "http://localhost:5678/webhook/lead-intake"

def post(p):
    req = urllib.request.Request(URL, json.dumps(p).encode(), {"Content-Type": "application/json"}, "POST")
    try:
        with urllib.request.urlopen(req, timeout=60) as r: return r.status, json.loads(r.read())
    except urllib.error.HTTPError as e:
        raw = e.read()
        try: return e.code, json.loads(raw or b"{}")
        except ValueError: return e.code, {"raw": raw[:200].decode(errors="replace")}

CASES = [
  ("infra org, LLM agrees",  {"company": "InfraCo", "domain": "infraco.io", "github_org": "infraco"},
     lambda c, r: c == 200 and r["status"] == "scored" and r["final_score"] == 5 and r["score_source"] == "llm" and r["hot"] is True),
  ("retail org scores low",  {"company": "RetailCo", "domain": "retailco.com", "github_org": "retailco"},
     lambda c, r: c == 200 and r["final_score"] == 1 and r["score_source"] == "llm" and r["hot"] is False),
  ("no GitHub org -> no guess", {"company": "Ghost", "domain": "ghost.io", "github_org": "ghost"},
     lambda c, r: c == 200 and r["status"] == "no_github_data" and r["final_score"] is None and r["llm_status"] == "skipped"),
  ("rate limited -> needs_retry", {"company": "Limited", "domain": "limited.io", "github_org": "limited"},
     lambda c, r: c == 200 and r["status"] == "needs_retry" and r["final_score"] is None),
  ("LLM returns junk -> rules fallback", {"company": "Garbage", "domain": "garbagellm.io", "github_org": "garbagellm"},
     lambda c, r: c == 200 and r["score_source"] == "rules_fallback" and r["llm_status"] == "parse_error" and r["final_score"] >= 4),
  ("LLM API 500 -> rules fallback", {"company": "Down", "domain": "llmdown.io", "github_org": "llmdown"},
     lambda c, r: c == 200 and r["score_source"] == "rules_fallback" and r["llm_status"] == "api_error"),
  ("messy URL is cleaned", {"company": "InfraCo again", "domain": "https://www.InfraCo.io/pricing?x=1", "github_org": "infraco"},
     lambda c, r: c == 200 and r["domain"] == "infraco.io"),
  ("bad input rejected with 422", {"company": "", "domain": "not a domain", "contact_email": "nope"},
     lambda c, r: c == 422 and r["status"] == "rejected" and len(r["errors"]) >= 3),
]
bad = 0
for name, payload, check in CASES:
    code, res = post(payload)
    ok = check(code, res)
    bad += not ok
    print(("PASS " if ok else "FAIL ") + name, "" if ok else f"\n   http={code} body={json.dumps(res)[:400]}")
    if ok and code == 200: print(f"     stored={res.get('stored')} score={res.get('final_score')} src={res.get('score_source')} review={res.get('needs_review')}")
print(f"\n{len(CASES) - bad}/{len(CASES)} passed")
sys.exit(1 if bad else 0)
