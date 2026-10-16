# Calling Jarvis

Jarvis, the CABLE 82 host, takes a line or a question at `POST /api/jarvis`.
These callers are ready to copy: change the address to your station's and run them.
The API itself is in [docs/api.md](../../docs/api.md#jarvis).

| File | What it is |
| --- | --- |
| [`say.sh`](say.sh) | The shell, with curl: `./say.sh "Good evening."` or `./say.sh --ask weather` |
| [`say.py`](say.py) | Python 3, standard library only: `python3 say.py "Good evening."` or `python3 say.py --ask joke` |
| [`say.mjs`](say.mjs) | Node 18 or newer, no packages: `node say.mjs "Good evening."` or `node say.mjs --ask time` |
| [`home-assistant.yaml`](home-assistant.yaml) | A `rest_command` for Home Assistant, and an automation that has Jarvis announce the front door |

Each one reads `CABLE82` from the environment for the station's address (`http://cable82.local:1982` when it is not set), checks what Jarvis can do with `GET /api/jarvis` first, and prints what he said and how many sets saw it.

CABLE 82 has no sign-in.
Whoever can reach the station can put Jarvis on the screen, the same way they can change the channel.
Keep it on your home network, not one you do not control.
