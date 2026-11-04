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
tools=post('tools/list')['result']['tools']
print('PASS tools:',len(tools))
def call(n,a):
    r=post('tools/call',{'name':n,'arguments':a})['result']
    assert not r.get('isError'),(n,r)
    return json.loads(r['content'][0]['text'])
P='+919900000001'
print(call('save_tenant_profile',{'phone':P,'name':'Test Tenant','whatsapp_ok':True,'locality':'Whitefield','bhk':2,'max_rent':35000,'amenities':['parking']})['profile'])
s=call('search_listings',{'locality':'Whitefield','bhk':2,'max_rent':35000,'amenities':['parking'],'limit':3})
print('search total',s['total_on_portal'],s.get('warning'),[(x['id'],x['locality'],x['rent'],x['match_score']) for x in s['results']])
lid=s['results'][0]['id']
call('add_to_wishlist',{'phone':P,'listing_id':lid,'note':'test'})
print('wishlist',len(call('get_wishlist',{'phone':P})['wishlist']))
b=call('negotiation_brief',{'listing_id':lid,'max_rent':35000})
print(json.dumps({k:b[k] for k in ('listing_rent','rent_vs_median_pct','rent_plan','deposit_plan')}))
r=call('research_locality',{'locality':'Whitefield','topics':['safety','scams']})
print('research',{k:len(v) for k,v in r['findings'].items()})
import datetime
t=(datetime.datetime.now(datetime.timezone.utc)+datetime.timedelta(days=3)).isoformat()
v=call('schedule_visit',{'phone':P,'listing_id':lid,'owner_phone':'+919900000002','owner_name':'Mr Rao','requested_time':t})
print('visit ai_call',v['visit_id'],v['call']['kind'],v['call']['status'])
ctx=call('get_outreach_context',{'outreach_id':v['call']['outreach_id']})['outreach']
print('owner briefing goal:',ctx['briefing']['goal'][:100])
r=call('record_owner_response',{'visit_id':v['visit_id'],'outcome':'reschedule','details':'Prefers Sunday','proposed_time':(datetime.datetime.now(datetime.timezone.utc)+datetime.timedelta(days=4)).isoformat()})
print('owner response ->',r['status'],'| tenant callback:',r['tenant_call']['kind'],r['tenant_call']['status'])
tctx=call('get_outreach_context',{'phone':P})['outreach']
print('tenant briefing purpose:',tctx['purpose'][:100])
print('confirm',call('confirm_proposed_time',{'visit_id':v['visit_id']})['visit']['status'])
dc=call('connect_with_owner',{'visit_id':v['visit_id']})
print('direct connect',dc['call']['kind'],dc['call']['status'])
v2=call('schedule_visit',{'phone':P,'listing_id':lid,'owner_phone':'+919900000003','requested_time':t,'mode':'direct_connect'})
print('visit direct_connect',v2['call']['kind'])
a=call('create_listing_alert',{'phone':P,'locality':'Whitefield','bhk':2,'max_rent':35000,'consent':True})
print('alert',a['alert_id'])
print('alert run',call('run_alert_check_now',{})['report'])
ag=call('draft_rental_agreement',{'phone':P,'listing_id':lid,'landlord_name':'Mr Rao','tenant_name':'Test Tenant','property_address':'Whitefield, Bengaluru','rent':b['rent_plan']['target'],'deposit':100000,'start_date':'2026-12-01'})
print('agreement chars',len(ag['agreement_text']))
print('deal',call('get_tenant_profile',{'phone':P})['deals'])
