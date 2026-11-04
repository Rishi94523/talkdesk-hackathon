"""Exercise a synthetic visit and callback in the live demo DB without calling.

Requires the server's dry_run_only support; never print tokens or phone numbers.
"""
import datetime, json, subprocess
from pathlib import Path

token=(Path(__file__).parent/'.mcp-token').read_text().strip()
def call(name, args):
    data=json.dumps({'jsonrpc':'2.0','id':1,'method':'tools/call','params':{'name':name,'arguments':args}})
    config='\n'.join(['url = "https://mergeconflicts-rentals-mcp.kelgis.workers.dev/mcp"','request = "POST"','header = "Content-Type: application/json"','header = "Accept: application/json, text/event-stream"','header = '+json.dumps('Authorization: Bearer '+token),'data = '+json.dumps(data)])+'\n'
    output=subprocess.run(['curl.exe','--silent','--show-error','--max-time','60','--config','-'],input=config,text=True,encoding='utf-8',capture_output=True,check=True).stdout
    if output.startswith('event:'): output=next(x[5:].strip() for x in output.splitlines() if x.startswith('data:'))
    result=json.loads(output)['result']
    assert not result.get('isError'), 'MCP tool reported an error'
    body=json.loads(result['content'][0]['text'])
    assert 'error' not in body, body.get('error')
    return body

test_tenant='+919900000001'  # synthetic, never dial while flows are configured
listing=call('listings',{'action':'search','locality':'Whitefield','bhk':2,'max_rent':35000,'limit':1})['results'][0]
when=(datetime.datetime.now(datetime.timezone.utc)+datetime.timedelta(days=4)).isoformat()
visit=call('visits',{'action':'schedule','phone':test_tenant,'listing_id':listing['id'],'requested_time':when,'dry_run_only':True})
assert visit['call']['status']=='dry_run', 'Unexpectedly configured owner flow'
owner=call('call_context',{'action':'load','outreach_id':visit['call']['outreach_id']})['outreach']
assert owner['briefing']['visit_id']==visit['visit_id']
result=call('owner_response',{'visit_id':visit['visit_id'],'outcome':'yes','details':'Demo owner accepted the requested time','dry_run_only':True})
assert result['status']=='confirmed' and result['tenant_call']['status']=='dry_run'
callback=call('call_context',{'action':'load','outreach_id':result['tenant_call']['outreach_id']})['outreach']
assert callback['briefing']['visit']['status']=='confirmed'
history=call('tenant',{'action':'get','phone':test_tenant})
assert any(x['id']==visit['visit_id'] and x['status']=='confirmed' for x in history['visits'])
print('PASS live dry run: visit -> owner briefing -> owner response -> tenant callback briefing -> saved visit')
