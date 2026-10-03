import urllib.request, json

def setup_owner():
    payload = json.dumps({"email":"admin@example.com","password":"Adminpassword1!","firstName":"Admin","lastName":"User"})
    req = urllib.request.Request('http://localhost:5678/rest/owner/setup', data=payload.encode(), headers={'Content-Type':'application/json'})
    try:
        res = urllib.request.urlopen(req)
        print("Setup OK:", res.read())
        cookies = res.info().get_all('Set-Cookie')
        print("Cookies:", cookies)
    except Exception as e:
        print("Setup Error:", e.read() if hasattr(e, 'read') else str(e))

def login():
    payload = json.dumps({"emailOrLdapLoginId":"admin@example.com","password":"Adminpassword1!"})
    req = urllib.request.Request('http://localhost:5678/rest/login', data=payload.encode(), headers={'Content-Type':'application/json'})
    try:
        res = urllib.request.urlopen(req)
        print("Login OK:", res.read())
        cookies = res.info().get_all('Set-Cookie')
        print("Cookies:", cookies)
    except Exception as e:
        print("Login Error:", e.read() if hasattr(e, 'read') else str(e))

setup_owner()
login()
