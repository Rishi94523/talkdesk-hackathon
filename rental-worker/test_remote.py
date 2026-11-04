"""Test an MCP endpoint without printing the bearer token."""
import json, sys, subprocess
from pathlib import Path
from urllib.request import Request, urlopen
from urllib.error import HTTPError
url=sys.argv[1].rstrip('/')+'/mcp'
token=(Path(__file__).parent/'.mcp-token').read_text().strip()
def post(method,params=None,id=1,auth=True):
    headers=['Content-Type: application/json','Accept: application/json, text/event-stream']
    if auth: headers.append('Authorization: Bearer '+token)
    payload=json.dumps({'jsonrpc':'2.0','id':id,'method':method,'params':params or {}})
    config='url = '+json.dumps(url)+'\nrequest = "POST"\n'+''.join('header = '+json.dumps(h)+'\n' for h in headers)+'data = '+json.dumps(payload)+'\nwrite-out = "\\n%{http_code}"\n'
    p=subprocess.run(['curl.exe','--silent','--show-error','--max-time','45','--config','-'],input=config,text=True,encoding='utf-8',capture_output=True,check=True)
    body,code=p.stdout.rsplit('\n',1)
    if int(code)>=400: raise HTTPError(url,int(code),'HTTP error',None,None)
    if body.startswith('event:'): body=next(x[5:].strip() for x in body.splitlines() if x.startswith('data:'))
    return json.loads(body)
try:
    post('tools/list',auth=False)
    raise SystemExit('FAIL: unauthenticated request was accepted')
except HTTPError as e:
    assert e.code==401, e.code
print('PASS unauthenticated request rejected')
init=post('initialize',{'protocolVersion':'2025-03-26','capabilities':{},'clientInfo':{'name':'mergeconflicts-test','version':'1.0'}})
assert 'result' in init, init
tools=post('tools/list')
assert len(tools['result']['tools'])>=5, tools
print('PASS initialized MCP; tool count:',len(tools['result']['tools']))
result=post('tools/call',{'name':'search_demo_listings','arguments':{'locality':'Whitefield','bhk':2,'max_rent':33000,'pets_required':True}})
assert 'MC-001' in json.dumps(result) and 'MC-002' not in json.dumps(result),result
print('PASS mock listing filter')
saved=post('tools/call',{'name':'save_demo_search','arguments':{'locality':'Whitefield','bhk':2,'max_rent':33000}})
assert not saved.get('result',{}).get('isError') and 'search_id' in json.dumps(saved),saved
print('PASS database write')
visit=post('tools/call',{'name':'request_demo_viewing','arguments':{'listing_id':'MC-001','requested_time':'Saturday 11am'}})
assert 'demo_request_not_confirmed' in json.dumps(visit),visit
print('PASS demo viewing remains unconfirmed')
if '--live' in sys.argv:
    live=post('tools/call',{'name':'discover_public_listings','arguments':{'objective':'Find 2 BHK apartments for rent in Whitefield Bangalore up to 35000 rupees, with listing pages.'}})
    if live.get('result',{}).get('isError'): raise SystemExit('FAIL hosted Parallel tool: '+json.dumps(live))
    content=live['result']['content'][0]['text']
    data=json.loads(content)
    assert isinstance(data.get('results'),list) and data['results'],data
    print('PASS hosted Parallel tool; candidate results:',len(data['results']))
