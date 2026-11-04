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
names=[t['name'] for t in post('tools/list')['result']['tools']]
print('PASS tools:',names)
def call(n,a):
    r=post('tools/call',{'name':n,'arguments':a})['result']
    assert not r.get('isError'),(n,r)
    d=json.loads(r['content'][0]['text']); assert 'error' not in d,(n,d); return d
import datetime
P='+919900000001'
g=call('tenant',{'action':'get','phone':P}); print('now',g['now_ist'])
call('tenant',{'action':'save_preferences','phone':P,'name':'Test Tenant','locality':'Whitefield','bhk':2,'max_rent':35000,'amenities':['parking']})
s=call('listings',{'action':'search','locality':'Whitefield','bhk':2,'max_rent':35000,'amenities':['parking'],'limit':3})
print('search',s['total_on_portal'],[(x['id'][:12],x['rent'],x['match_score']) for x in s['results']])
lid=s['results'][0]['id']
call('tenant',{'action':'wishlist_add','phone':P,'listing_id':lid})
print('negotiate',call('research',{'action':'negotiate','listing_id':lid,'max_rent':35000})['rent_plan'])
print('research',{k:len(v) for k,v in call('research',{'action':'locality','locality':'Whitefield','topics':['safety','scams']})['findings'].items()})
t=(datetime.datetime.now(datetime.timezone.utc)+datetime.timedelta(days=3)).isoformat()
v=call('visits',{'action':'schedule','phone':P,'listing_id':lid,'owner_phone':'+919900000002','owner_name':'Mr Rao','requested_time':t})
print('schedule ai_call ->',v['call']['kind'],v['call']['status'])
ctx=call('call_context',{'action':'load','phone':'+919900000002'})
print('owner agent loads briefing:',ctx['outreach']['briefing']['goal'][:80])
r=call('owner_response',{'visit_id':v['visit_id'],'outcome':'reschedule','details':'Sunday works better','proposed_time':(datetime.datetime.now(datetime.timezone.utc)+datetime.timedelta(days=4)).isoformat(),'quoted_rent':15000})
print('owner said reschedule ->',r['status'],'| tenant callback',r['tenant_call']['kind'])
tc=call('call_context',{'action':'load','phone':P})
print('tenant agent loads:',tc['outreach']['purpose'][:90])
print('accept',call('visits',{'action':'accept_owner_time','visit_id':v['visit_id']})['visit']['status'])
call('call_context',{'action':'complete','outreach_id':tc['outreach']['id'],'summary':'Tenant accepted Sunday'})
print('direct connect',call('visits',{'action':'connect_owner','visit_id':v['visit_id']})['call']['kind'])
oc=call('call_context',{'action':'load','phone':'+919900000002'})
print('owner asks for tenant ->',call('call_context',{'action':'connect_tenant','outreach_id':oc['outreach']['id']})['forward_to'])
print('alert',call('tenant',{'action':'alert_create','phone':P,'consent':True})['criteria'])
print('check_new',call('listings',{'action':'check_new'})['report'])
ag=call('deal',{'action':'draft_agreement','phone':P,'listing_id':lid,'landlord_name':'Mr Rao','tenant_name':'Test Tenant','property_address':'Whitefield','rent':15000,'deposit':60000,'start_date':'2026-12-01'})
print('agreement chars',len(ag['agreement_text']))
print('final state',call('tenant',{'action':'get','phone':P})['deals'])
