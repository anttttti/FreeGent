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
