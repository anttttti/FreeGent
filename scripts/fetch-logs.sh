#!/usr/bin/env bash
# Pulls user-sent chat logs (POST /log -> FG_LOGS KV on the CF Worker) for review and keeps a
# list of the ones already reviewed so they are skipped next time.
#
#   scripts/fetch-logs.sh            download logs not yet fetched or reviewed, print their paths
#   scripts/fetch-logs.sh pending    list downloaded logs that are not marked reviewed
#   scripts/fetch-logs.sh mark ID..  mark logs reviewed (ID = key without "log:"); "mark --all"
#                                    marks every downloaded log
#   scripts/fetch-logs.sh status     counts
#
# Logs hold users' chats, so they live outside the repo:
#   downloads  ~/.local/share/freegent/logs/<id>.json   (override: FG_LOGS_DIR)
#   reviewed   ~/.config/freegent/reviewed-logs.txt     (override: FG_REVIEWED_FILE)
# Logs expire from KV after 14 days; review before then (downloaded copies are kept).
# Needs CLOUDFLARE_API_TOKEN in ~/.config/freegent/credentials (KV read permission).
set -euo pipefail

DIR="${FG_LOGS_DIR:-$HOME/.local/share/freegent/logs}"
REVIEWED="${FG_REVIEWED_FILE:-$HOME/.config/freegent/reviewed-logs.txt}"
CREDS="$HOME/.config/freegent/credentials"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
mkdir -p "$DIR" "$(dirname "$REVIEWED")"; touch "$REVIEWED"

is_reviewed() { grep -qxF "$1" "$REVIEWED"; }
downloaded()  { for f in "$DIR"/*.json; do [ -e "$f" ] && basename "$f" .json; done; }

cmd="${1:-fetch}"
case "$cmd" in
  fetch)
    if [ -z "${CLOUDFLARE_API_TOKEN:-}" ] && [ -f "$CREDS" ]; then
      CLOUDFLARE_API_TOKEN="$(grep -E '^CLOUDFLARE_API_TOKEN=' "$CREDS" | cut -d= -f2-)"
    fi
    export CLOUDFLARE_API_TOKEN
    cd "$ROOT/cf-worker"
    ids="$(npx wrangler kv key list --binding FG_LOGS --remote \
      | python3 -c 'import json,sys; [print(k["name"][4:]) for k in json.load(sys.stdin) if k["name"].startswith("log:")]')"
    new=0
    for id in $ids; do
      is_reviewed "$id" && continue
      [ -e "$DIR/$id.json" ] && continue
      npx wrangler kv key get "log:$id" --binding FG_LOGS --remote > "$DIR/$id.json"
      echo "$DIR/$id.json"; new=$((new + 1))
    done
    echo "fetched $new new log(s); mark reviewed with: scripts/fetch-logs.sh mark <id>..." >&2 ;;
  pending)
    for id in $(downloaded); do is_reviewed "$id" || echo "$DIR/$id.json"; done ;;
  mark)
    shift
    [ "${1:-}" = "--all" ] && set -- $(downloaded)
    for id in "$@"; do
      id="$(basename "${id%.json}")"
      is_reviewed "$id" || echo "$id" >> "$REVIEWED"
    done
    echo "reviewed total: $(wc -l < "$REVIEWED")" ;;
  status)
    d=$(downloaded | wc -l); p=$(for id in $(downloaded); do is_reviewed "$id" || echo "$id"; done | wc -l)
    echo "downloaded: $d, pending review: $p, reviewed: $(wc -l < "$REVIEWED")" ;;
  *) sed -n '2,12p' "$0"; exit 1 ;;
esac
