import json,urllib.request,urllib.error,sys
URL="http://localhost:5678/webhook/lead-intake"
def post(p):
    r=urllib.request.Request(URL,json.dumps(p).encode(),{"Content-Type":"application/json"},"POST")
    try:
        with urllib.request.urlopen(r,timeout=60) as x:return x.status,json.loads(x.read())
    except urllib.error.HTTPError as e:
        b=e.read()
        try:return e.code,json.loads(b)
        except Exception:return e.code,b[:200]
for name,p in [
 ("new company, explicit org",{"company":"InfraCo","domain":"infraco.io","github_org":"infraco"}),
 ("existing in HubSpot",{"company":"Existing","domain":"existing.io","github_org":"infraco"}),
 ("scrape finds org",{"company":"Scrape","domain":"scrapeok.io"}),
 ("scrape noisy page",{"company":"Noisy","domain":"noisy.io"}),
 ("no link anywhere",{"company":"Nolink","domain":"nolink.io"}),
 ("postgres down",{"company":"Pg","domain":"pgfail.io","github_org":"infraco"}),
 ("no github (404 org)",{"company":"Ghost","domain":"ghost.io","github_org":"ghost"}),
]:
    c,r=post(p);print(name,c,json.dumps({k:r.get(k) for k in("status","github_org","github_source","final_score","stored","crm","crm_error")} if isinstance(r,dict) else r)[:300])
if len(sys.argv)>1:
    pass
