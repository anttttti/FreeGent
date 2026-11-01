# FreeGent Cloudflare Worker

A small proxy that lets the static FreeGent site call model providers, which mostly do not allow direct browser requests. The official instance runs at `proxy.freegent.ai` and is used automatically by `freegent.ai`. **Most users never deploy this.** You need your own copy only if you host FreeGent on another origin, want another provider allowed, or want shared keys for your own users. The guide for that is [docs/self-hosting.md](../docs/self-hosting.md); the quick version is below.

## What it does

- `POST` (model calls): forwards only to an allow-list of hosts (`ALLOWED_HOSTS` in `worker.js`): Gemini, Groq, OpenRouter, Nous, Kilo, NVIDIA NIM, TokenHarbor, Vercel AI Gateway, OpenAI, Tavily and Brave.
- `GET ?url=` (page fetches, searches): forwards to any public HTTPS address, for clients with a session token from a Cloudflare Turnstile check (`POST /session`), the Developer key, or on a Worker with `FG_OPEN_RELAY=1`.
- `GET /keys`: tells the page which shared provider keys exist, as `true`/`false` per provider. Values are never sent.
- Optional shared keys: stored as Worker secrets and injected only for requests that carry the Developer key (`X-FG-Dev-Key`, matched against the `FG_DEV_KEY` secret). Visitors without it always use their own keys.
- Developer-key sessions can also upload console errors and finished Autopilot chats (`/errlog`, `/log`) to KV for the maintainer to review. Users can also send a chat log on purpose.

- Project sync (optional, Developer key): `POST /sync/auth` trades the key for a 15-minute token; `/sync/projects`, `/sync/<project>/manifest`, `/sync/<project>/b/<sha256>`, `/sync/<project>/gc` and `DELETE /sync/<project>` keep a project's files as content-addressed objects in an R2 bucket bound as `FG_SYNC`. Only changed files travel, and a push replaces the manifest only if nobody pushed since (compare-and-swap). Without the binding every `/sync` route answers 503 and nothing is stored. To enable it: `npx wrangler r2 bucket create freegent-sync` (R2 needs a payment method on the Cloudflare account, though the free tier of 10 GB is not charged), then uncomment the `r2_buckets` block in `wrangler.toml` and deploy. In FreeGent, **☁ Sync** appears next to Import/Export once a Developer key is saved. To run it on a separate Worker later, deploy the same code under another name with its own bucket and `FG_DEV_KEY`, and put that Worker's URL in Settings → Privacy.

## Protections

- **Origin check.** Only the origins in `ALLOWED_ORIGINS` are served (freegent.ai, the old GitHub Pages URL and local dev ports). An `Origin` header is easy to forge from a non-browser client, so it stops other websites, not other programs.
- **Turnstile on the fetch path.** Without it, `?url=` would be an open web relay for any script. The page passes an invisible Cloudflare Turnstile check once per session and trades it at `POST /session` for a session token: an HMAC over the expiry and the client's network (IPv4 address or IPv6 /64), valid four hours. The page sends the token as `X-FG-Session` (`relay-session.ts`). Without `TURNSTILE_SITE_KEY`, `TURNSTILE_SECRET` and `FG_SESSION_KEY`, the fetch path answers `503`, unless `FG_OPEN_RELAY=1` marks the Worker as private.
- **Rate limit.** A per-IP limit (`ratelimits` in `wrangler.toml`) bounds use of shared keys and of the open `?url=` fetch path, and guesses at the Developer key.
- **Host allow-list** for `POST`, HTTPS only, no credentials in URLs.
- **Nothing is retained** apart from the opt-in logs above. API keys, whether the user's or injected, are forwarded to the provider and not stored.

## Deploy your own

1. Create a free Cloudflare account.
2. In `wrangler.toml`, delete `workers_dev = false` and the `routes = …` line (they bind the official instance to `proxy.freegent.ai`). Change `name` to change the URL slug.
3. Add your site's origin to `ALLOWED_ORIGINS` in `worker.js`.
4. Set up Turnstile for the fetch path. In the Cloudflare dashboard, go to Turnstile → Add widget, with your site's hostname and mode Managed. Put its site key in `wrangler.toml` (`TURNSTILE_SITE_KEY` under `[vars]`), then:
   ```bash
   npx wrangler secret put TURNSTILE_SECRET     # the widget's secret key
   npx wrangler secret put FG_SESSION_KEY       # any long random string (openssl rand -hex 32)
   ```
   For a Worker nobody else can reach, `FG_OPEN_RELAY = "1"` under `[vars]` skips this instead.
5. Deploy:
   ```bash
   cd cf-worker
   npx wrangler deploy
   # or: CLOUDFLARE_API_TOKEN=<token> npx wrangler deploy
   ```
6. In FreeGent, open **Settings → Privacy → CORS Proxy / CF Worker URL** and paste the URL it prints.

### Shared keys (optional)

```bash
npx wrangler secret put GROQ_API_KEY        # also OPENROUTER_API_KEY, GEMINI_API_KEY, NOUS_API_KEY,
                                            # TOKENHARBOR_API_KEY, NVIDIA_API_KEY, VERCEL_API_KEY,
                                            # MOONMATH_API_KEY, REQUESTY_API_KEY
npx wrangler secret put FG_DEV_KEY          # the Developer key that unlocks them
```

The WebUI is deployed separately by the GitHub Pages workflow after a push to `main`
(`./deploy.sh --git-only` runs the checks, builds, and pushes it). Deploying this Worker
or uploading secrets does not update the WebUI's Settings fields or model catalog.

Whether you may share a key depends on the provider's terms, and most forbid handing a key to others. Groq allows serving end users through your own application. OpenRouter forbids reselling or transferring access. Gemini's free tier may not serve users in the EEA, Switzerland or the UK. The NVIDIA trial may not be made available to others. Whoever owns the key is responsible for everything done with it. Read the terms of each provider before you share.

## Limits (Cloudflare free plan)

| | Free | Workers Paid |
|---|---|---|
| Requests | 100,000 per day | 10 million per month |
| Wall time per request | 30 seconds | 30 minutes |

Very long generations on slow models can hit the 30-second limit.
