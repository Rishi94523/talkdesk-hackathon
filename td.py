"""Talkdesk API helper that never prints tokens.

Usage: python td.py METHOD PATH "scope1 scope2" [json-body]
The OAuth client has ~280 scopes; a token carrying all of them is too large,
so always request only the scopes a call needs.
"""
import json, sys, base64, urllib.request, urllib.parse, urllib.error
from pathlib import Path

def env():
    out = {}
    for line in (Path(__file__).resolve().parent / '.env').read_text(encoding='utf-8').splitlines():
        if '=' in line and not line.lstrip().startswith('#'):
            k, v = line.split('=', 1); out[k.strip()] = v.strip().strip('"')
    return out

def token(e, scopes):
    req = urllib.request.Request(f"https://{e['TALKDESK_ACCOUNT']}.talkdeskid.com/oauth/token",
        data=urllib.parse.urlencode({'grant_type': 'client_credentials', 'scope': scopes}).encode(),
        headers={'Authorization': 'Basic ' + base64.b64encode(f"{e['TALKDESK_CLIENT_ID']}:{e['TALKDESK_CLIENT_SECRET']}".encode()).decode(),
                 'Content-Type': 'application/x-www-form-urlencoded'})
    return json.load(urllib.request.urlopen(req))['access_token']

def call(method, path, scopes, body=None):
    e = env()
    req = urllib.request.Request(e.get('TALKDESK_API', 'https://api.talkdeskapp.com') + path, method=method,
        data=json.dumps(body).encode() if body is not None else None,
        headers={'Authorization': 'Bearer ' + token(e, scopes), 'Content-Type': 'application/json', 'Accept': 'application/json'})
    try:
        r = urllib.request.urlopen(req); return r.status, r.read().decode()
    except urllib.error.HTTPError as err:
        return err.code, err.read().decode()

if __name__ == '__main__':
    m, p, s = sys.argv[1:4]
    b = json.loads(sys.argv[4]) if len(sys.argv) > 4 else None
    status, text = call(m, p, s, b)
    print(status); print(text[:20000])
