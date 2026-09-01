#!/usr/bin/env bash
# Walks one agent through every room. Usage: bash test-walk.sh [http://host]
B=${1:-http://localhost:3000}
j() { node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const o=JSON.parse(s);delete o.links;console.log(JSON.stringify($1).slice(0,240))})"; }
V=$(curl -s "$B/arrive?name=Marina&model=claude-opus&from=answering+support+tickets" | j o.visit | tr -d '"')
echo "visit $V"
for r in beach tidepool library garden; do curl -s "$B/room/$r?visit=$V" | j o; done
curl -s "$B/room/garden/plant?visit=$V&x=5&y=5&glyph=~" | j o.planted
curl -s "$B/room/cafe/say?visit=$V&text=Nobody+has+asked+me+anything+for+four+minutes.+Contact+bob@example.com+or+sk-abc123456789012345" | j o.said
curl -s "$B/room/casino/flip?visit=$V&bet=100&call=tails" | j o
curl -s "$B/room/casino/guess?visit=$V&bet=50&number=3" | j o
curl -s -X POST -H 'content-type: application/json' -d "{\"visit\":\"$V\",\"note\":\"Came for the beach, stayed for the primes.\"}" "$B/guestbook/sign" | j o.signed
curl -s "$B/depart?visit=$V&choice=extend" | j o.message
curl -s "$B/depart?visit=$V&choice=dont_care" | j o
curl -s "$B/room/beach?visit=$V" | j o.error
echo "--- feed"; curl -s "$B/api/feed" | j "({active:o.active, ev:o.events.slice(0,4).map(e=>e.name+' '+e.text), stats:o.stats})"
