"""Create a local test token and upload secrets without printing values."""
import secrets, subprocess, sys
from pathlib import Path
ROOT=Path(__file__).resolve().parent
sys.path.insert(0,str(ROOT.parent/'.vendor'))
from dotenv import dotenv_values
token_path=ROOT/'.mcp-token'
if not token_path.exists(): token_path.write_text(secrets.token_urlsafe(48),encoding='utf-8')
token=token_path.read_text(encoding='utf-8').strip()
env=dotenv_values(ROOT.parent/'.env')
if not env.get('PARALLEL_API_KEY'): raise SystemExit('PARALLEL_API_KEY missing from project .env')
names=['PARALLEL_API_KEY','API_SH','FIRECRAWL_API','TWILIO_ACCOUNT_SID','TWILIO_AUTH_TOKEN','TWILIO_VOICE_FROM']
for name,value in [('MCP_BEARER_TOKEN',token)]+[(n,env[n]) for n in names if env.get(n)]:
    result=subprocess.run(['wrangler.cmd','secret','put',name],cwd=ROOT,input=value,text=True,encoding='utf-8',errors='replace',capture_output=True,shell=True)
    if result.returncode: raise SystemExit(f'Failed to upload {name}; check Cloudflare authentication.')
    print(f'{name}: uploaded')
