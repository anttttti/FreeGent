# FreeGent — Claude Code project rules

## Deployment

**Never run `git push` or `git push origin` directly.**
Always use `./deploy.sh` (or `./deploy.sh --git-only` / `./deploy.sh --worker-only`).

The script runs safety, bug, and leak checks before any push or CF Worker deploy.
A `pre-push` git hook enforces this; bare `git push` is rejected.

To deploy the CF Worker only:
```
./deploy.sh --worker-only
```

To push code to GitHub Pages only:
```
./deploy.sh --git-only
```

To run checks and build without deploying anything:
```
./deploy.sh --check-only
```

## CF Worker secrets

Store the Cloudflare API token in `~/.config/freegent/credentials` (never in the repo):
```
CLOUDFLARE_API_TOKEN=cfut_...
```

Add or rotate CF Worker secrets via:
```
cd cf-worker && CLOUDFLARE_API_TOKEN=... npx wrangler secret put <SECRET_NAME>
```

## Reviewing user-sent chat logs

Users can send chat logs to the Worker (stored in the `FG_LOGS` KV for 14 days). To review:
```
scripts/fetch-logs.sh            # download logs not yet fetched/reviewed, prints file paths
scripts/fetch-logs.sh pending    # downloaded but not yet reviewed
scripts/fetch-logs.sh mark <id>… # or `mark --all`, once reviewed (so they're skipped next time)
```
Sessions that have a Developer key saved (Settings → API Credentials) also upload: console errors/warnings
(`POST /errlog`, KV keys `err:<sessionId>:…`) and the chat of each finished/failed/blocked Autopilot task
(`POST /log`, field `devSession`). The `sessionId` / `devSession` value joins the two streams. Turn a
reproducible failure into a unit test or a simulation scenario (see the benchmark repository's "What tests what").
Logs and the reviewed list live outside the repo (`~/.local/share/freegent/logs/`,
`~/.config/freegent/reviewed-logs.txt`) because they contain users' chats. Never copy them into the repo.

## Evaluation and smoke tests

Unit tests: `npx vitest run`. Smoke tests, simulations, browser-level checks of the WebUI and benchmarks live in a
separate benchmark repository, whose `CLAUDE.md` and `BENCHMARKS.md` ("What tests what") say which to use when.
