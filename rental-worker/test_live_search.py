"""Live MCP search smoke test; refreshes listing cache and uses search credits."""
import json, subprocess
from pathlib import Path

token = (Path(__file__).parent / '.mcp-token').read_text().strip()
payload = {'jsonrpc':'2.0','id':1,'method':'tools/call','params':{'name':'listings','arguments':{'action':'search','locality':'Whitefield','bhk':3,'max_rent':25000,'max_deposit':75000,'amenities':['gym','garden'],'furnishing':'full','limit':2}}}
config = '\n'.join(['url = "https://mergeconflicts-rentals-mcp.kelgis.workers.dev/mcp"','request = "POST"','header = "Content-Type: application/json"','header = "Accept: application/json, text/event-stream"','header = '+json.dumps('Authorization: Bearer '+token),'data = '+json.dumps(json.dumps(payload))])+'\n'
p = subprocess.run(['curl.exe','--silent','--show-error','--max-time','60','--config','-'],input=config,text=True,encoding='utf-8',capture_output=True,check=True)
body = p.stdout
if body.startswith('event:'): body = next(line[5:].strip() for line in body.splitlines() if line.startswith('data:'))
r=json.loads(body)['result']
assert not r.get('isError'), 'MCP search failed'
d=json.loads(r['content'][0]['text']); l=d['results'][0]
assert l['title']=='MergeConflicts Garden Residences' and l['is_showcase']
assert l['locality']=='Whitefield' and l['bhk']==3 and l['rent']<=25000 and l['deposit']<=75000
assert l['furnishing']=='full' and 'garden' in l['amenities'] and not l['mismatches']
print('PASS live adaptive Whitefield showcase search; provider leads:',len(d.get('web_candidates',[])))
