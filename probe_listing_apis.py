"""Make one small request to each provider; never print credentials."""
import json, os, sys
from pathlib import Path
from urllib.parse import urlencode
from urllib.request import Request, urlopen
from urllib.error import HTTPError, URLError

ROOT=Path(__file__).resolve().parent
sys.path.insert(0,str(ROOT/'.vendor'))
from dotenv import load_dotenv
load_dotenv(ROOT/'.env')

def call(name, url, key, body=None):
    if not key:
        print(name, 'missing key'); return
    headers={'x-api-key':key,'Accept':'application/json'}
    if body is not None: headers['Content-Type']='application/json'
    req=Request(url,data=json.dumps(body).encode() if body is not None else None,headers=headers,method='POST' if body else 'GET')
    try:
        with urlopen(req,timeout=60) as res: data=json.load(res)
        if name == 'Parallel':
            results=data.get('results',[])
            print(json.dumps({'provider':name,'status':'ok','count':len(results),'results':[{'title':r.get('title'),'url':r.get('url'),'publish_date':r.get('publish_date'),'excerpt':(r.get('excerpts') or [''])[0][:450]} for r in results[:5]],'warnings':data.get('warnings',[])},ensure_ascii=True))
        else:
            print(json.dumps({'provider':name,'status':'ok','response':data},ensure_ascii=False)[:12000])
    except HTTPError as e:
        print(json.dumps({'provider':name,'status':'http_error','code':e.code,'detail':e.read(1000).decode('utf-8','replace')}))
    except (URLError,TimeoutError) as e:
        print(json.dumps({'provider':name,'status':'network_error','detail':str(e.reason if isinstance(e,URLError) else e)}))

call('Parallel','https://api.parallel.ai/v1/search',os.getenv('PARALLEL_API_KEY'),{'objective':'Find individual residential rental listings for a 2 BHK apartment in Whitefield, Bengaluru under 35000 INR per month, with rent and source listing link.','search_queries':['2 BHK rent Whitefield Bangalore under 35000'], 'mode':'fast'})
