#!/usr/bin/env bash
# End-to-end: three members on one machine, separate CONTEXTER_HOMEs, email OTP via local Mailpit.
set -euo pipefail
cd "$(dirname "$0")/.."
S=$(mktemp -d); trap 'rm -rf "$S"' EXIT; mkdir -p "$S/homes"
docker exec -i supabase_db_contexter psql -U postgres -qtAc "delete from public.workspaces where slug='retrieval-paper';" >/dev/null
eval "$(npx supabase status -o env 2>/dev/null | grep -E '^(API_URL|PUBLISHABLE_KEY)=')"
ctx() { local who=$1; shift; CONTEXTER_HOME="$S/homes/$who" npx tsx packages/cli/src/index.ts "$@"; }
code_for() {  # newest OTP mailed to $1
  for _ in $(seq 20); do
    id=$(curl -s "http://127.0.0.1:55324/api/v1/search?query=to:$1&limit=1" | node -e 'const j=JSON.parse(require("fs").readFileSync(0));process.stdout.write(j.messages?.[0]?.ID??"")')
    [ -n "$id" ] && { curl -s "http://127.0.0.1:55324/api/v1/message/$id" | node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(0)).Text.match(/\b\d{6}\b/)[0]+"\n")'; return; }
    sleep 0.5
  done; echo "no mail for $1" >&2; return 1
}
login() { (sleep 1.5; code_for "$1@test.local") | ctx "$1" login --email "$1@test.local"; }
curl -s -X DELETE http://127.0.0.1:55324/api/v1/messages >/dev/null

for who in alice bob carol; do ctx $who setup --url "$API_URL" --key "$PUBLISHABLE_KEY" >/dev/null; login $who; done

echo "── alice creates the paper workspace"
ctx alice init retrieval-paper --handle alice --name "Retrieval paper" --template research-paper
CODE=$(ctx alice invite --uses 2 | sed -n 's/^  \(.*\)$/\1/p' | head -1)
VCODE=$(ctx alice invite --role viewer | sed -n 's/^  \(.*\)$/\1/p' | head -1)

echo "── bob and carol join"
ctx bob join "$CODE" --handle bob
ctx carol join "$VCODE" --handle carol

echo "── carol (viewer) tries to invite → should fail"
ctx carol invite && echo "UNEXPECTED: viewer created invite" || true

echo "── reuse check: the 2-use code still works once more, then fails"
mkdir -p "$S/homes/dave"; ctx dave setup --url "$API_URL" --key "$PUBLISHABLE_KEY" >/dev/null; login dave
ctx dave join "$CODE" --handle dave
mkdir -p "$S/homes/eve"; ctx eve setup --url "$API_URL" --key "$PUBLISHABLE_KEY" >/dev/null; login eve
ctx eve join "$CODE" --handle eve && echo "UNEXPECTED: used-up code worked" || true
ctx eve status && echo "UNEXPECTED: outsider has a workspace" || true

echo "── bob's view"
ctx bob workspaces
ctx bob status | head -8
echo "── alice's feed (should show bob, carol, dave joining)"
ctx alice feed
echo "── alice's feed again (should be empty)"
ctx alice feed
