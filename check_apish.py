"""One diagnostic request; credentials passed to curl over stdin only."""
import json, subprocess, sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent / '.vendor'))
from dotenv import dotenv_values
key=dotenv_values(Path(__file__).resolve().parent / '.env').get('API_SH')
if not key: raise SystemExit('API_SH missing')
config='url = "https://api.api.sh/nobroker/v1/search?city=bangalore&kind=rent&bhk=2"\nheader = '+json.dumps('x-api-key: '+key)+'\nheader = "Accept: application/json"\nwrite-out = "\\n%{http_code}"\n'
result=subprocess.run(['curl.exe','--silent','--show-error','--max-time','60','--config','-'],input=config,text=True,encoding='utf-8',capture_output=True)
if result.returncode: raise SystemExit('Curl failed: '+result.stderr[:400])
body,status=result.stdout.rsplit('\n',1)
try:
    data=json.loads(body)
except json.JSONDecodeError:
    print(json.dumps({'status':status,'body':body[:500]})); raise SystemExit()
print(json.dumps({'status':status,'body':data},ensure_ascii=True)[:15000])
