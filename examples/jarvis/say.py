#!/usr/bin/env python3
"""Put Jarvis on CABLE 82.

    python3 say.py "Good evening."
    python3 say.py --ask weather        (weather, cheerlights, time, joke)

The station's address comes from CABLE82 (default http://cable82.local:1982).
Standard library only.
"""
import json
import os
import sys
import urllib.error
import urllib.request

STATION = os.environ.get("CABLE82", "http://cable82.local:1982").rstrip("/")


def call(method, body=None):
    req = urllib.request.Request(
        STATION + "/api/jarvis",
        data=None if body is None else json.dumps(body).encode(),
        method=method,
        headers={"content-type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=15) as r:
            return json.load(r)
    except urllib.error.HTTPError as e:
        sys.exit(f"CABLE 82 said {e.code}: {e.read().decode().strip()}")
    except urllib.error.URLError as e:
        sys.exit(f"cannot reach {STATION}: {e.reason}")


def main(args):
    if not args:
        sys.exit(__doc__)
    about = call("GET")
    if not about["enabled"]:
        sys.exit(f"{about['name']} is switched off in the control room")
    if args[0] == "--ask":
        if len(args) < 2 or args[1] not in about["asks"]:
            sys.exit("ask one of: " + ", ".join(about["asks"]))
        said = call("POST", {"ask": args[1]})
    else:
        said = call("POST", {"text": " ".join(args)})
    where = f"on {said['listeners']} set(s)" if said["listeners"] else "but no set is listening"
    voice = "out loud" if said["voice"] else "on screen"
    print(f"{about['name']} said {voice}, {where}: {said['text']}")


if __name__ == "__main__":
    main(sys.argv[1:])
