import json,sys
wf=json.load(open(sys.argv[1]))
wf["id"]="leadRadarE2E00001";wf["name"]="e2e"
for n in wf["nodes"]:
    p=n["parameters"];nm=n["name"]
    def strip():
        for k in("authentication","genericAuthType"):p.pop(k,None)
        n.pop("credentials",None)
    if nm=="GitHub Repos":p["url"]=p["url"].replace("https://api.github.com","http://127.0.0.1:9001");strip()
    if nm in("Claude Score","Groq Score"):
        p["url"]="http://127.0.0.1:9002"+("/openai/v1/chat/completions" if "groq" in p["url"] else "/v1/messages");strip();n["maxTries"]=2;n["waitBetweenTries"]=500
    if nm=="Scrape Homepage":p["url"]="=http://127.0.0.1:9004/{{ $json.domain }}"
    if nm.startswith("HubSpot") and "url" in p:
        p["url"]=p["url"].replace("https://api.hubapi.com","http://127.0.0.1:9003");strip()
    if nm=="Upsert Lead":
        n["type"]="n8n-nodes-base.code";n["typeVersion"]=2;n["parameters"]={"jsCode":"return $('Parse & Merge').item.json.domain==='pgfail.io' ? [{json:{error:{message:'pg down'}}}] : [{json:{id:1}}];"};n.pop("credentials",None)
wf["nodes"]=[n for n in wf["nodes"] if n["name"]!="Slack Alert"]
wf["connections"].pop("Slack Alert",None)
for o in wf["connections"]["Hot lead?"]["main"]:o[:]=[{"node":"Upsert Lead","type":"main","index":0}]
json.dump(wf,open(sys.argv[2],"w"),indent=2)
