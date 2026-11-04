"""Read only the team's matching Talkdesk queues using a narrowly scoped token."""
import base64
import json
import re
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path


def main():
    values = {}
    for line in Path(__file__).with_name('.env').read_text(encoding='utf-8').splitlines():
        match = re.match(r'^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$', line)
        if match:
            values[match.group(1)] = match.group(2).strip().strip('\"\'')
    try:
        account = values['TALKDESK_ACCOUNT']
        basic = base64.b64encode((values['TALKDESK_CLIENT_ID'] + ':' + values['TALKDESK_CLIENT_SECRET']).encode()).decode()
    except KeyError:
        print('Missing Talkdesk OAuth configuration in .env.')
        return
    payload = urllib.parse.urlencode({'grant_type': 'client_credentials', 'scope': 'queues:read'}).encode()
    request = urllib.request.Request('https://' + account + '.talkdeskid.com/oauth/token', data=payload,
                                     headers={'Authorization': 'Basic ' + basic}, method='POST')
    stage = 'OAuth'
    try:
        with urllib.request.urlopen(request, timeout=20) as response:
            token = json.load(response)['access_token']
        print('OAuth queues:read: success')
        stage = 'queue lookup'
        query = urllib.parse.urlencode({'name': 'MergeConflicts', 'page': 1, 'per_page': 20})
        request = urllib.request.Request('https://api.talkdeskapp.com/ccaas/queues?' + query,
                                         headers={'Authorization': 'Bearer ' + token})
        with urllib.request.urlopen(request, timeout=20) as response:
            data = json.load(response)
        print('Matching queue count:', data.get('total', 'unknown'))
        for queue in data.get('_embedded', {}).get('queues', []):
            print('Queue:', queue.get('name', 'unknown'))
    except urllib.error.HTTPError as error:
        print(stage, 'failed with HTTP', error.code)
        if stage == 'OAuth':
            try:
                code = json.load(error).get('error', '')
                if code in {'invalid_scope', 'invalid_client', 'invalid_request', 'unauthorized_client', 'unsupported_grant_type'}:
                    print('OAuth error category:', code)
            except (ValueError, AttributeError):
                pass
    except (urllib.error.URLError, TimeoutError, KeyError, ValueError) as error:
        print(stage, 'failed:', type(error).__name__)


if __name__ == '__main__':
    main()
