import urllib.request, json, os

def req(url, payload=None, cookie=None, method=None):
    headers = {'Content-Type':'application/json'}
    if cookie: headers['Cookie'] = cookie
    data = json.dumps(payload).encode() if payload else None
    request = urllib.request.Request('http://localhost:5678' + url, data=data, headers=headers, method=method)
    try:
        res = urllib.request.urlopen(request)
        d = json.loads(res.read())
        if 'data' in d: return d['data'], res.info().get_all('Set-Cookie')
        return d, res.info().get_all('Set-Cookie')
    except Exception as e:
        print(f"Error on {url}:", e.read() if hasattr(e, 'read') else str(e))
        raise

def main():
    print("Login...")
    data, cookies = req('/rest/login', {"emailOrLdapLoginId":"admin@example.com","password":"Adminpassword1!"})
    cookie = [c.split(';')[0] for c in cookies if 'n8n-auth' in c][0]
    
    print("Listing workflows...")
    wfs, _ = req('/rest/workflows', cookie=cookie)
    
    for wf in wfs:
        print("Activating", wf['name'])
        wf['active'] = True
        req(f'/rest/workflows/{wf["id"]}', cookie=cookie, payload=wf, method='PUT')
    
    print("DONE")

main()
