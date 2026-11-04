"""Live MCP search smoke test; refreshes listing cache and uses search credits."""
import json, subprocess
from pathlib import Path

token = (Path(__file__).parent / '.mcp-token').read_text().strip()
payload = {'jsonrpc':'2.0','id':1,'method':'tools/call','params':{'name':'listings','arguments':{'action':'search','locality':'Whitefield','bhk':2,'max_rent':40000,'amenities':['swimming pool']}}}
config = '\n'.join(['url = "https://mergeconflicts-rentals-mcp.kelgis.workers.dev/mcp"','request = "POST"','header = "Content-Type: application/json"','header = "Accept: application/json, text/event-stream"','header = '+json.dumps('Authorization: Bearer '+token),'data = '+json.dumps(json.dumps(payload))])+'\n'
p = subprocess.run(['curl.exe','--silent','--show-error','--max-time','60','--config','-'],input=config,text=True,encoding='utf-8',capture_output=True,check=True)
body = p.stdout
if body.startswith('event:'): body = next(line[5:].strip() for line in body.splitlines() if line.startswith('data:'))
r=json.loads(body)['result']
assert not r.get('isError'), 'MCP search failed'
d=json.loads(r['content'][0]['text'])
opts=d['options']
assert opts[0]['source']=='demo_showcase' and opts[0]['title']=='MergeConflicts Garden Residences'
assert len([o for o in opts if o['group']=='read_now'])==5, len(opts)
assert opts[0]['facts']['owner_name']=='Rishi D V' and 'details' in opts[0]['facts'] and 'phone' not in json.dumps(opts[0]['facts'])
assert all(o['brief'] and 'http' not in o['brief'] for o in opts if o['source']!='web')
for o in opts: print(o['number'], o['source'], '|', o['brief'][:110])
print('total options', len(opts), 'payload chars', len(r['content'][0]['text']))
print('PASS live search returns 5 briefed options with the showcase first')
