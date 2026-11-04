# MergeConflicts rental MCP prototype

The Python prototype below is local-only and unauthenticated. Do not expose it publicly. The separate Cloudflare Worker in `rental-worker/` has been deployed with a bearer token and is not connected to Talkdesk.

Install dependencies with `python -m pip install -r requirements.txt` or use the project-local `.vendor` directory. Run `python realestate_mcp.py` and connect an MCP client to `http://127.0.0.1:8765/mcp`. Run `python test_local_mcp.py` for a transport and tools smoke test. This creates a local SQLite file that is ignored by Git.

`search_demo_listings`, `get_demo_listing`, `save_demo_search` and `request_demo_viewing` use only fictional records. A viewing is a demo request, never an actual appointment. Searches are saved locally; no notifications are sent. `discover_public_listings` uses Parallel and spends credits; its results are unverified web candidates, not guaranteed available. It needs `PARALLEL_API_KEY` in `.env`. Do not put credentials into source or tool arguments.

This Python version is a prototype: before exposing it add authentication, authorization and session isolation, a hosted database, consent and notification workflows, operational logging without secrets, validation, rate limits and source-specific usage review. No WhatsApp, outbound AI calls or scheduled monitoring is implemented.

## Cloudflare test deployment

Endpoint: `https://mergeconflicts-rentals-mcp.kelgis.workers.dev/mcp`. The Worker requires a private bearer token, stored in `rental-worker/.mcp-token` and as a Cloudflare secret. The Parallel key is stored as a Worker secret. Do not commit or share either. Cloudflare D1 `mergeconflicts-rentals-demo` stores demonstration searches and unconfirmed viewing requests. Eight fictional listings are embedded in the Worker. The deployment is not attached to Talkdesk.

Run `python rental-worker/test_remote.py https://mergeconflicts-rentals-mcp.kelgis.workers.dev` to test rejection without a token, MCP initialization, listing filtering and D1 writes. Add `--live` to also invoke Parallel (uses provider credits). Tests create demonstration search and viewing rows. The Worker has one shared bearer token, no user isolation, no rate limiting and no production consent or notification implementation. It is suitable only for a controlled demo; avoid real personal data. To connect Talkdesk later, validate its supported bearer-token configuration and add appropriate authentication and authorization.

## Talkdesk inspection and API.SH diagnostic

The Talkdesk custom MCP server form has name, description, status, URL and authentication options None, BearerToken and OAuth2. BearerToken takes a token; OAuth2 presents client ID, client secret, token URL and scope. Talkdesk documentation specifies Streamable HTTP and says each discovered MCP tool is added as a separate agent skill. The form was inspected and cancelled; no server or skill was created and no connection test was run. Thus actual Talkdesk request headers, version negotiation, runtime timeout and response parsing have not been observed. A separate MCP-over-HTTP test of the Worker passed, which is evidence of protocol behavior but not proof of Talkdesk interoperability.

On 2026-11-03 a single API.SH NoBroker search using curl returned HTTP 200 with 26 rows and a reported total of 197. The first rows contained differing locality names but identical coordinates matching the returned search centre. Treat coordinates and the radius filter as unverified until checked against individual source pages; fields can be missing or stale. API.SH says it is a third-party provider and omits owner contact details. The earlier Python request received Cloudflare 1010; the successful later test used curl after the user disabled the VPN, so the specific cause of the change is unknown. No API.SH integration has been added to the Worker yet.
