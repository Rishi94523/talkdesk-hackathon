"""Local-only MergeConflicts rental demonstration MCP server."""
import json
import os
import sqlite3
import sys
from datetime import datetime, timezone
from pathlib import Path
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT / '.vendor'))
from dotenv import load_dotenv
from mcp.server.fastmcp import FastMCP

load_dotenv(ROOT / '.env')
DB = ROOT / 'mergeconflicts_demo.sqlite3'
mcp = FastMCP('MergeConflicts Rentals', host='127.0.0.1', port=8765, stateless_http=True, json_response=True)

MOCKS = [
 ('MC-001','Whitefield',2,32000,150000,'semi-furnished',1,1,'Near metro; covered parking','2026-12-01'),
 ('MC-002','Whitefield',2,35000,180000,'furnished',0,1,'Balcony; gym','2026-11-20'),
 ('MC-003','Brookefield',2,29000,120000,'semi-furnished',1,0,'Balcony; no parking','2026-11-15'),
 ('MC-004','Indiranagar',1,28000,140000,'furnished',0,0,'Near metro','2026-12-01'),
 ('MC-005','Sarjapur Road',3,48000,240000,'semi-furnished',1,1,'Pool; parking','2026-12-15'),
 ('MC-006','Bellandur',2,39000,200000,'unfurnished',1,1,'Lift; parking','2026-11-25'),
 ('MC-007','HSR Layout',1,25000,100000,'semi-furnished',1,0,'Balcony','2026-11-15'),
 ('MC-008','Marathahalli',2,31000,150000,'semi-furnished',0,1,'Lift; parking','2026-12-01'),
]

def connect():
    db = sqlite3.connect(DB)
    db.row_factory = sqlite3.Row
    db.execute('PRAGMA foreign_keys=ON')
    return db

def init_db():
    with connect() as db:
        db.executescript('''
        CREATE TABLE IF NOT EXISTS listings (id TEXT PRIMARY KEY, locality TEXT NOT NULL, bhk INTEGER NOT NULL, rent INTEGER NOT NULL, deposit INTEGER, furnishing TEXT, pets INTEGER, parking INTEGER, features TEXT, available_from TEXT, source TEXT NOT NULL DEFAULT 'mock', status TEXT NOT NULL DEFAULT 'demo');
        CREATE TABLE IF NOT EXISTS searches (id INTEGER PRIMARY KEY, locality TEXT, bhk INTEGER, max_rent INTEGER, pets INTEGER, alerts_consent INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS viewings (id INTEGER PRIMARY KEY, listing_id TEXT NOT NULL REFERENCES listings(id), requested_time TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'demo_request_not_confirmed', created_at TEXT NOT NULL);
        ''')
        db.executemany('INSERT OR IGNORE INTO listings(id,locality,bhk,rent,deposit,furnishing,pets,parking,features,available_from) VALUES(?,?,?,?,?,?,?,?,?,?)', MOCKS)

@mcp.tool()
def search_demo_listings(locality: str = '', bhk: int = 0, max_rent: int = 0, pets_required: bool = False, parking_required: bool = False) -> dict:
    """Search synthetic Bengaluru rental data; no listing is real or bookable."""
    query = 'SELECT * FROM listings WHERE source = ?'
    args = ['mock']
    if locality:
        query += ' AND locality LIKE ?'; args.append('%' + locality + '%')
    if bhk:
        query += ' AND bhk = ?'; args.append(bhk)
    if max_rent:
        query += ' AND rent <= ?'; args.append(max_rent)
    if pets_required: query += ' AND pets = 1'
    if parking_required: query += ' AND parking = 1'
    with connect() as db:
        rows = [dict(row) for row in db.execute(query + ' ORDER BY rent, id LIMIT 10', args)]
    return {'notice':'All listings are fictional demo data, not real or bookable.', 'results': rows}

@mcp.tool()
def get_demo_listing(listing_id: str) -> dict:
    """Get a fictional listing by its MC identifier."""
    with connect() as db:
        row = db.execute('SELECT * FROM listings WHERE id=? AND source=?', (listing_id, 'mock')).fetchone()
    return {'notice':'Fictional demo data.', 'listing': dict(row) if row else None}

@mcp.tool()
def save_demo_search(locality: str, bhk: int, max_rent: int, pets_required: bool = False, alerts_consent: bool = False) -> dict:
    """Save demo search criteria locally; consent is recorded but no alerts are sent."""
    if not locality or bhk < 1 or max_rent < 1: raise ValueError('Provide locality, positive bhk and max_rent.')
    with connect() as db:
        cur = db.execute('INSERT INTO searches(locality,bhk,max_rent,pets,alerts_consent,created_at) VALUES(?,?,?,?,?,?)', (locality,bhk,max_rent,int(pets_required),int(alerts_consent),datetime.now(timezone.utc).isoformat()))
        return {'search_id':cur.lastrowid,'alerts_active':False,'notice':'Stored locally for demo only; no notifications configured.'}

@mcp.tool()
def request_demo_viewing(listing_id: str, requested_time: str) -> dict:
    """Record a fictional viewing request, never a real booking or confirmation."""
    if not requested_time.strip(): raise ValueError('A requested time is required.')
    with connect() as db:
        if not db.execute('SELECT 1 FROM listings WHERE id=? AND source=?',(listing_id,'mock')).fetchone(): raise ValueError('Unknown demo listing.')
        cur=db.execute('INSERT INTO viewings(listing_id,requested_time,created_at) VALUES(?,?,?)',(listing_id,requested_time,datetime.now(timezone.utc).isoformat()))
        return {'request_id':cur.lastrowid,'status':'demo_request_not_confirmed','notice':'No owner was contacted and no visit is booked.'}

def parallel_search(objective: str) -> dict:
    """Search the public web. Results are candidates, not verified availability."""
    key = os.getenv('PARALLEL_API_KEY')
    if not key: raise RuntimeError('PARALLEL_API_KEY is missing.')
    body=json.dumps({'objective':objective, 'search_queries':[objective], 'mode':'fast'}).encode()
    req=Request('https://api.parallel.ai/v1/search', data=body, headers={'x-api-key':key,'Content-Type':'application/json'}, method='POST')
    with urlopen(req, timeout=40) as response: data=json.load(response)
    return {'notice':'Web results are unverified candidates; rent and availability may be stale or missing.','results':data.get('results',[]),'warnings':data.get('warnings',[])}

@mcp.tool()
def discover_public_listings(objective: str) -> dict:
    """Search the public web using Parallel; this spends API credits and does not verify listings."""
    if not objective.strip() or len(objective)>500: raise ValueError('Supply a search objective up to 500 characters.')
    return parallel_search(objective)

if __name__ == '__main__':
    init_db()
    mcp.run(transport='streamable-http')
