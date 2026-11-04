"""Exercise the real MCP HTTP transport and local tools without external calls."""
import asyncio, json, os, subprocess, sys, time
from pathlib import Path
ROOT=Path(__file__).resolve().parent
sys.path.insert(0,str(ROOT/'.vendor'))
from mcp import ClientSession
from mcp.client.streamable_http import streamable_http_client

async def exercise():
    async with streamable_http_client('http://127.0.0.1:8765/mcp') as (read,write,_):
        async with ClientSession(read,write) as session:
            await session.initialize()
            names={tool.name for tool in (await session.list_tools()).tools}
            assert {'search_demo_listings','get_demo_listing','save_demo_search','request_demo_viewing','discover_public_listings'} <= names
            result=await session.call_tool('search_demo_listings',{'locality':'Whitefield','bhk':2,'max_rent':33000,'pets_required':True})
            assert not result.isError, result
            data=result.structuredContent or json.loads(result.content[0].text)
            assert [x['id'] for x in data['results']] == ['MC-001'], data
            save=await session.call_tool('save_demo_search',{'locality':'Whitefield','bhk':2,'max_rent':33000})
            assert not save.isError and (save.structuredContent or json.loads(save.content[0].text))['alerts_active'] is False
            visit=await session.call_tool('request_demo_viewing',{'listing_id':'MC-001','requested_time':'Saturday 11am'})
            assert not visit.isError and (visit.structuredContent or json.loads(visit.content[0].text))['status']=='demo_request_not_confirmed'
            missing=await session.call_tool('request_demo_viewing',{'listing_id':'not-real','requested_time':'Saturday'})
            assert missing.isError
            print('PASS: HTTP MCP initialization, five tools, constrained search, saved search, demo viewing and invalid listing.')

if __name__=='__main__':
    proc=subprocess.Popen([sys.executable,str(ROOT/'realestate_mcp.py')],cwd=ROOT,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
    try:
        time.sleep(3)
        asyncio.run(exercise())
    finally:
        proc.terminate(); proc.wait(timeout=10)
