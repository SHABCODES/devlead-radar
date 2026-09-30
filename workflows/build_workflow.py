#!/usr/bin/env python3
"""Generate the n8n workflow JSON files from nodes/*.js.

The Code-node scripts live in nodes/ so they can be unit tested and diffed.
This script inlines them into importable workflow files. Run from anywhere:
    python3 workflows/build_workflow.py
"""
import argparse
import json
import os
import uuid
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
NS = uuid.UUID("6f1c2b1e-0d7a-4c53-9a53-5e0f7c1a9d10")


def uid(name):
    return str(uuid.uuid5(NS, name))


def js(name):
    return (ROOT / "nodes" / name).read_text()


def node(name, type_, version, params, pos, **extra):
    n = {
        "parameters": params,
        "id": uid(name),
        "name": name,
        "type": type_,
        "typeVersion": version,
        "position": pos,
    }
    n.update(extra)
    return n


def code(name, file, pos, **subs):
    src = js(file)
    for k, v in subs.items():
        src = src.replace(f"__BUILD_{k.upper()}__", json.dumps(v))
    return node(
        name, "n8n-nodes-base.code", 2,
        {"mode": "runOnceForEachItem", "language": "javaScript", "jsCode": src}, pos,
    )


def if_node(name, left, operator, right, pos):
    cond = {"id": uid(name + "-cond"), "leftValue": left, "rightValue": right, "operator": operator}
    return node(
        name, "n8n-nodes-base.if", 2.2,
        {
            "conditions": {
                "options": {"caseSensitive": True, "leftValue": "", "typeValidation": "strict", "version": 2},
                "conditions": [cond],
                "combinator": "and",
            },
            "options": {},
        },
        pos,
    )


def note(text, pos, w=320, h=180):
    return node("Note " + text[:18], "n8n-nodes-base.stickyNote", 1,
                {"content": text, "height": h, "width": w}, pos)


def link(*pairs):
    """link(("A", "B"), ("B", "C", 1)) -> connections dict. Optional 3rd item = output index."""
    conns = {}
    for p in pairs:
        src, dst = p[0], p[1]
        idx = p[2] if len(p) > 2 else 0
        outs = conns.setdefault(src, {"main": []})["main"]
        while len(outs) <= idx:
            outs.append([])
        outs[idx].append({"node": dst, "type": "main", "index": 0})
    return conns


UPSERT_SQL = """INSERT INTO leads
  (domain, company, github_org, contact_name, contact_email, source, status,
   final_score, score_source, llm_score, llm_confidence, reason, opener,
   rule_score, rule_tier, needs_review, signals)
VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17::jsonb)
ON CONFLICT (domain) DO UPDATE SET
  company = EXCLUDED.company, github_org = EXCLUDED.github_org,
  contact_name = COALESCE(EXCLUDED.contact_name, leads.contact_name),
  contact_email = COALESCE(EXCLUDED.contact_email, leads.contact_email),
  source = EXCLUDED.source, status = EXCLUDED.status,
  final_score = EXCLUDED.final_score, score_source = EXCLUDED.score_source,
  llm_score = EXCLUDED.llm_score, llm_confidence = EXCLUDED.llm_confidence,
  reason = EXCLUDED.reason, opener = EXCLUDED.opener,
  rule_score = EXCLUDED.rule_score, rule_tier = EXCLUDED.rule_tier,
  needs_review = EXCLUDED.needs_review, signals = EXCLUDED.signals,
  updated_at = now()
RETURNING id, (xmax = 0) AS inserted;"""

UPSERT_ARGS = (
    "={{ (() => { const l = $('Parse & Merge').item.json; return ["
    "l.domain, l.company, l.github_org, l.contact_name, l.contact_email, l.source, l.status, "
    "l.final_score, l.score_source, l.llm_score, l.llm_confidence, l.reason, l.opener, "
    "l.rule_score, l.rule_tier, l.needs_review, JSON.stringify(l.signals)]; })() }}"
)


PROVIDERS = {
    "anthropic": {
        "node": "Claude Score",
        "url": "https://api.anthropic.com/v1/messages",
        "headers": [{"name": "anthropic-version", "value": "2023-06-01"}],
        "model": "claude-haiku-4-5-20251001",
        "cred": {"id": "anthropic-key", "name": "Anthropic API key"},
        "wait": 3000,
        "body": ("={{ JSON.stringify({ model: '%(model)s', max_tokens: 400, temperature: 0, "
                 "system: $json.llm_system, messages: [{ role: 'user', content: $json.llm_user }] }) }}"),
    },
    "groq": {
        "node": "Groq Score",
        "url": "https://api.groq.com/openai/v1/chat/completions",
        "headers": [{"name": "Authorization", "value": "Bearer " + os.environ.get("GROQ_API_KEY", "YOUR_GROQ_API_KEY")}],
        "model": "openai/gpt-oss-120b",
        "cred": None,
        "wait": 6000,
        "body": ("={{ JSON.stringify({ model: '%(model)s', max_tokens: 1024, temperature: 0, "
                 "response_format: { type: 'json_object' }, messages: [{ role: 'system', content: $json.llm_system }, "
                 "{ role: 'user', content: $json.llm_user }] }) }}"),
    },
}


def main_workflow(github_auth=False, provider="anthropic", model=None, hide_keyword_hits=False):
    prov = PROVIDERS[provider]
    model = model or prov["model"]
    score_name = prov["node"]
    nodes = [
        node("Lead Intake", "n8n-nodes-base.webhook", 2,
             {"httpMethod": "POST", "path": "lead-intake", "responseMode": "responseNode", "options": {}},
             [0, 300], webhookId=uid("webhook")),
        code("Normalize & Validate", "01_normalize.js", [220, 300]),
        if_node("Valid lead?", "={{ $json.valid }}",
                {"type": "boolean", "operation": "true", "singleValue": True}, "", [440, 300]),
        node("Respond Rejected", "n8n-nodes-base.respondToWebhook", 1.1,
             {"respondWith": "json",
              "responseBody": "={{ { status: 'rejected', domain: $json.domain, errors: $json.errors } }}",
              "options": {"responseCode": 422}}, [660, 480]),
        node("GitHub Repos", "n8n-nodes-base.httpRequest", 4.2,
             {"method": "GET",
              "url": "=https://api.github.com/orgs/{{ $json.github_org }}/repos?per_page=100&sort=pushed&type=public",
              "sendHeaders": True,
              "headerParameters": {"parameters": [
                  {"name": "Accept", "value": "application/vnd.github+json"},
                  {"name": "X-GitHub-Api-Version", "value": "2022-11-28"},
                  {"name": "User-Agent", "value": "devlead-radar"}]},
              "options": {"timeout": 15000,
                          "response": {"response": {"neverError": True, "fullResponse": True}}}},
             [660, 200], onError="continueRegularOutput"),
        code("Compute Signals", "02_signals.js", [880, 200]),
        if_node("Enough data for AI?", "={{ $json.data_quality }}",
                {"type": "string", "operation": "equals"}, "ok", [1100, 200]),
        code("Build Prompt", "03_build_prompt.js", [1320, 120],
             hide_keyword_hits=hide_keyword_hits),
        node(score_name, "n8n-nodes-base.httpRequest", 4.2,
             {"method": "POST", "url": prov["url"],
              **({"authentication": "genericCredentialType", "genericAuthType": "httpHeaderAuth"} if prov.get("cred") else {}),
              "sendHeaders": bool(prov["headers"]),
              **({"headerParameters": {"parameters": prov["headers"]}} if prov["headers"] else {}),
              "sendBody": True, "specifyBody": "json",
              "jsonBody": prov["body"] % {"model": model},
              "options": {"timeout": 30000}},
             [1540, 120], retryOnFail=True, maxTries=3, waitBetweenTries=prov["wait"],
             onError="continueRegularOutput",
             **({"credentials": {"httpHeaderAuth": prov["cred"]}} if prov.get("cred") else {})),
        code("Parse & Merge", "04_parse_merge.js", [1760, 200]),
        if_node("Hot lead?", "={{ $json.hot }}",
                {"type": "boolean", "operation": "true", "singleValue": True}, "", [1980, 200]),
        node("Slack Alert", "n8n-nodes-base.httpRequest", 4.2,
             {"method": "POST", "url": "https://hooks.slack.com/services/REPLACE/ME/PLEASE",
              "sendBody": True, "specifyBody": "json",
              "jsonBody": "={{ JSON.stringify({ text: ':fire: Hot lead: ' + $json.company + ' (' + $json.domain + ') score ' + $json.final_score + '/5\\n' + ($json.reason || '') + ($json.needs_review ? '\\n:warning: LLM and rules disagree, review before outreach' : '') }) }}",
              "options": {}},
             [2200, 100], disabled=True, onError="continueRegularOutput"),
        node("Upsert Lead", "n8n-nodes-base.postgres", 2.5,
             {"operation": "executeQuery", "query": UPSERT_SQL,
              "options": {"queryReplacement": UPSERT_ARGS}},
             [2420, 200], onError="continueRegularOutput",
             credentials={"postgres": {"id": "crm-postgres", "name": "CRM Postgres"}}),
        node("Respond OK", "n8n-nodes-base.respondToWebhook", 1.1,
             {"respondWith": "json",
              "responseBody": "={{ Object.assign({}, $('Parse & Merge').item.json, { stored: $json.id !== undefined }) }}",
              "options": {"responseCode": 200}},
             [2640, 200]),
        note("## Lead Radar\nPOST a lead to /webhook/lead-intake.\nValidate -> GitHub signals -> rule score -> Claude score -> upsert to Postgres -> reply with the result.", [-20, 60], 360, 160),
        note("Leads with no usable GitHub data skip the LLM call on purpose, so the model never has to guess.", [1060, 340], 300, 100),
        note("The model call retries 3x. If it still fails, or returns junk, the rule score is used and the row says so (score_source = rules_fallback).", [1300, -80], 340, 110),
    ]
    if github_auth:
        gh = next(n for n in nodes if n["name"] == "GitHub Repos")
        gh["parameters"]["authentication"] = "genericCredentialType"
        gh["parameters"]["genericAuthType"] = "httpHeaderAuth"
        gh["credentials"] = {"httpHeaderAuth": {"id": "1a7eniFZ2Fn9lvdc", "name": "GitHub token"}}
    connections = link(
        ("Lead Intake", "Normalize & Validate"),
        ("Normalize & Validate", "Valid lead?"),
        ("Valid lead?", "GitHub Repos", 0),
        ("Valid lead?", "Respond Rejected", 1),
        ("GitHub Repos", "Compute Signals"),
        ("Compute Signals", "Enough data for AI?"),
        ("Enough data for AI?", "Build Prompt", 0),
        ("Enough data for AI?", "Parse & Merge", 1),
        ("Build Prompt", score_name),
        (score_name, "Parse & Merge"),
        ("Parse & Merge", "Hot lead?"),
        ("Hot lead?", "Slack Alert", 0),
        ("Hot lead?", "Upsert Lead", 1),
        ("Slack Alert", "Upsert Lead"),
        ("Upsert Lead", "Respond OK"),
    )
    return {"id": "leadRadarMain0001", "name": "Lead Radar: enrich and score", "nodes": nodes, "connections": connections,
            "active": False, "settings": {"executionOrder": "v1"}, "pinData": {}}


ERROR_CODE = """const e = $json;
return { json: {
  workflow: e.workflow && e.workflow.name,
  node: e.execution && e.execution.lastNodeExecuted,
  message: (e.execution && e.execution.error && e.execution.error.message) || 'unknown',
  execution_id: e.execution && e.execution.id,
} };"""


def error_workflow():
    nodes = [
        node("Error Trigger", "n8n-nodes-base.errorTrigger", 1, {}, [0, 0]),
        node("Format Error", "n8n-nodes-base.code", 2,
             {"mode": "runOnceForEachItem", "language": "javaScript", "jsCode": ERROR_CODE}, [220, 0]),
        node("Log Error", "n8n-nodes-base.postgres", 2.5,
             {"operation": "executeQuery",
              "query": "INSERT INTO workflow_errors (workflow, node, message, execution_id) VALUES ($1,$2,$3,$4);",
              "options": {"queryReplacement": "={{ [$json.workflow, $json.node, $json.message, String($json.execution_id)] }}"}},
             [440, 0], credentials={"postgres": {"id": "crm-postgres", "name": "CRM Postgres"}}),
    ]
    connections = link(("Error Trigger", "Format Error"), ("Format Error", "Log Error"))
    return {"id": "leadRadarErr00001", "name": "Lead Radar: error handler", "nodes": nodes, "connections": connections,
            "active": False, "settings": {"executionOrder": "v1"}, "pinData": {}}


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--provider", choices=list(PROVIDERS), default="anthropic",
                    help="which LLM API to call (default: anthropic)")
    ap.add_argument("--model", help="override the provider's default model id")
    ap.add_argument("--github-auth", action="store_true",
                    help="use a Header Auth credential named 'GitHub token' (Authorization: Bearer <pat>)")
    ap.add_argument("--hide-keyword-hits", action="store_true",
                    help="experiment: omit keyword_hits from the facts sent to the model")
    args = ap.parse_args()
    out = ROOT / "workflows"
    for fname, wf in [("lead-radar.json", main_workflow(args.github_auth, args.provider, args.model, args.hide_keyword_hits)), ("error-handler.json", error_workflow())]:
        (out / fname).write_text(json.dumps(wf, indent=2) + "\n")
        print("wrote", fname, len(wf["nodes"]), "nodes")
