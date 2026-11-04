#!/usr/bin/env bash
# Talkdesk API helper. Usage:
#   SCOPES="data-tables:read" ./td.sh GET /data-tables/export/jobs
#   SCOPES="contacts:read" ./td.sh token
# The client has ~280 scopes; a token carrying all of them is too large and the
# API answers 400, so always request only the scopes a call needs via SCOPES.
set -euo pipefail
cd "$(dirname "$0")"
set -a; source .env; set +a
: "${SCOPES:?set SCOPES to the space-separated scopes this call needs}"

token() {
  curl -s -X POST "https://${TALKDESK_ACCOUNT}.talkdeskid.com/oauth/token" \
    -u "${TALKDESK_CLIENT_ID}:${TALKDESK_CLIENT_SECRET}" \
    -d "grant_type=client_credentials" \
    --data-urlencode "scope=${SCOPES}" | sed -n 's/.*"access_token":"\([^"]*\)".*/\1/p'
}

if [ "${1:-}" = "token" ]; then token; exit; fi

method="${1:?method}"; path="${2:?path}"; shift 2
curl -s -X "$method" "${TALKDESK_API}${path}" \
  -H "Authorization: Bearer $(token)" \
  -H "Content-Type: application/json" "$@"
echo
