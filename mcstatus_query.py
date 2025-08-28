#!/usr/bin/env python
import sys
import json
try:
    from mcstatus import JavaServer
except Exception:
    # mcstatus not available
    print(json.dumps({"error": "no_mcstatus"}))
    sys.exit(0)

def parse_status(hostport):
    try:
        server = JavaServer.lookup(hostport)
        status = server.status()
        motd = ''
        try:
            # status.description can be dict or string
            if hasattr(status, 'description'):
                motd = str(status.description)
        except Exception:
            motd = ''
        players = getattr(status.players, 'online', None)
        maxp = getattr(status.players, 'max', None)
        if players is None:
            players = 0
        if maxp is None:
            maxp = 0
        # try to extract favicon (data:image/png;base64,...) from status.raw if present
        favicon = None
        try:
            raw = getattr(status, 'raw', None)
            if raw and isinstance(raw, dict):
                favicon = raw.get('favicon') or raw.get('icon')
        except Exception:
            favicon = None

        out = {
            'online': True,
            'players': players,
            'maxPlayers': maxp,
            'motd': motd,
            'version': getattr(status.version, 'name', '') if hasattr(status, 'version') else '',
            'favicon': favicon
        }
        print(json.dumps(out))
    except Exception as e:
        print(json.dumps({'online': False, 'error': str(e)}))

if __name__ == '__main__':
    if len(sys.argv) < 2:
        print(json.dumps({'online': False, 'error': 'no_host'}))
        sys.exit(0)
    host = sys.argv[1]
    parse_status(host)
