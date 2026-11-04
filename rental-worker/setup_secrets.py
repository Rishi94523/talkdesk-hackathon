"""Create a local test token and upload secrets without printing values."""
import secrets, subprocess, sys
from pathlib import Path
ROOT=Path(__file__).resolve().parent
sys.path.insert(0,str(ROOT.parent/'.vendor'))
from dotenv import dotenv_values
token_path=ROOT/'.mcp-token'
if not token_path.exists(): token_path.write_text(secrets.token_urlsafe(48),encoding='utf-8')
token=token_path.read_text(encoding='utf-8').strip()
api_key=dotenv_values(ROOT.parent/'.env').get('PARALLEL_API_KEY')
if not api_key: raise SystemExit('PARALLEL_API_KEY missing from project .env')
for name,value in [('MCP_BEARER_TOKEN',token),('PARALLEL_API_KEY',api_key)]:
    result=subprocess.run(['wrangler.cmd','secret','put',name],cwd=ROOT,input=value,text=True,encoding='utf-8',errors='replace',capture_output=True,shell=True)
    if result.returncode: raise SystemExit(f'Failed to upload {name}; check Cloudflare authentication.')
    print(f'{name}: uploaded')
