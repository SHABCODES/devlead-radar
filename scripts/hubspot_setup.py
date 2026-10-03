#!/usr/bin/env python3
"""Create the three custom company properties the workflow writes to HubSpot.

HubSpot does not "expect" property names. You choose the internal name when you create the property,
and the workflow must use exactly that name. This script creates the names the workflow uses:
devlead_score, devlead_reason, github_org. Safe to re-run: existing properties are left alone.

    export HUBSPOT_TOKEN=pat-...      # private app token with crm.schemas.companies.write
    python3 scripts/hubspot_setup.py --check    # list which exist, change nothing
    python3 scripts/hubspot_setup.py            # create the missing ones

Needed scopes on the private app: crm.objects.companies.read, crm.objects.companies.write,
crm.schemas.companies.read, crm.schemas.companies.write.
"""
import argparse, json, os, sys, urllib.request, urllib.error

BASE = os.environ.get("HUBSPOT_BASE", "https://api.hubapi.com")
PROPS = [
    {"name": "devlead_score", "label": "DevLead score (1-5)", "type": "number", "fieldType": "number"},
    {"name": "devlead_reason", "label": "DevLead reason", "type": "string", "fieldType": "textarea"},
    {"name": "github_org", "label": "GitHub org", "type": "string", "fieldType": "text"},
]

def call(method, path, body=None):
    req = urllib.request.Request(BASE + path, json.dumps(body).encode() if body is not None else None,
        {"Authorization": "Bearer " + os.environ["HUBSPOT_TOKEN"], "Content-Type": "application/json"}, method)
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return r.status, json.loads(r.read() or b"{}")
    except urllib.error.HTTPError as e:
        raw = e.read()
        try: return e.code, json.loads(raw)
        except ValueError: return e.code, {"message": raw[:200].decode(errors="replace")}

def main():
    ap = argparse.ArgumentParser(); ap.add_argument("--check", action="store_true")
    a = ap.parse_args()
    if not os.environ.get("HUBSPOT_TOKEN"): sys.exit("Set HUBSPOT_TOKEN first.")
    bad = 0
    for p in PROPS:
        code, res = call("GET", "/crm/v3/properties/companies/" + p["name"])
        if code == 200: print(f"exists   {p['name']}"); continue
        if code != 404: print(f"ERROR    {p['name']}: HTTP {code} {res.get('message')}"); bad += 1; continue
        if a.check: print(f"MISSING  {p['name']}"); bad += 1; continue
        code, res = call("POST", "/crm/v3/properties/companies", {**p, "groupName": "companyinformation"})
        if code in (200, 201): print(f"created  {p['name']}")
        else: print(f"ERROR    {p['name']}: HTTP {code} {res.get('message')}"); bad += 1
    sys.exit(1 if bad else 0)

main()
