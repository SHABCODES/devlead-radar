#!/usr/bin/env python3
"""Copy lead-radar.json with GitHub and Anthropic pointed at local mocks. Prints the new path."""
import json, sys
src, dst = sys.argv[1], sys.argv[2]
wf = json.load(open(src))
wf["id"] = "leadRadarE2E00001"
wf["name"] = "Lead Radar E2E (mocked)"
for n in wf["nodes"]:
    p = n["parameters"]
    if n["name"] == "GitHub Repos":
        p["url"] = p["url"].replace("https://api.github.com", "http://127.0.0.1:9001")
        for k in ("authentication", "genericAuthType"): p.pop(k, None)
        n.pop("credentials", None)
    if n["name"] == "Claude Score":
        p["url"] = "http://127.0.0.1:9002/v1/messages"
        for k in ("authentication", "genericAuthType"): p.pop(k, None)
        n.pop("credentials", None)
        n["maxTries"] = 2; n["waitBetweenTries"] = 500
wf["nodes"] = [n for n in wf["nodes"] if n["name"] != "Slack Alert"]
wf["connections"].pop("Slack Alert", None)
for o in wf["connections"]["Hot lead?"]["main"]:
    o[:] = [{"node": "Upsert Lead", "type": "main", "index": 0}] if o or True else o
json.dump(wf, open(dst, "w"), indent=2)
print(dst)
