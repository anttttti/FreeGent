# FreeGent Cloudflare Worker

A small proxy that lets the static FreeGent site call model providers, which mostly do not allow direct browser requests. The official instance runs at `proxy.freegent.ai` and is used automatically by `freegent.ai`. **Most users never deploy this.** You need your own copy only if you host FreeGent on another origin, want another provider allowed, or want shared keys for your own users. The guide for that is [docs/self-hosting.md](../docs/self-hosting.md); the quick version is below.

## What it does

- `POST` (model calls): forwards only to an allow-list of hosts (`ALLOWED_HOSTS` in `worker.js`): Gemini, Groq, OpenRouter, Nous, Kilo, NVIDIA NIM, TokenHarbor, Vercel AI Gateway, OpenAI, Tavily and Brave.
- `GET ?url=` (page fetches, searches): forwards to any public HTTPS address.
- `GET /keys`: tells the page which shared provider keys exist, as `true`/`false` per provider. Values are never sent.
- Optional shared keys: stored as Worker secrets and injected only for requests that carry the Developer key (`X-FG-Dev-Key`, matched against the `FG_DEV_KEY` secret). Visitors without it always use their own keys.
- Developer-key sessions can also upload console errors and finished Autopilot chats (`/errlog`, `/log`) to KV for the maintainer to review. Users can also send a chat log on purpose.

## Protections

- **Origin check.** Only the origins in `ALLOWED_ORIGINS` are served (freegent.ai, the old GitHub Pages URL and local dev ports). An `Origin` header is easy to forge from a non-browser client, so it stops other websites, not other programs.
- **Rate limit.** A per-IP limit (`ratelimits` in `wrangler.toml`) bounds use of shared keys and of the open `?url=` fetch path, and guesses at the Developer key.
- **Host allow-list** for `POST`, HTTPS only, no credentials in URLs.
- **Nothing is retained** apart from the opt-in logs above. API keys, whether the user's or injected, are forwarded to the provider and not stored.

## Deploy your own

1. Create a free Cloudflare account.
2. In `wrangler.toml`, delete `workers_dev = false` and the `routes = …` line (they bind the official instance to `proxy.freegent.ai`). Change `name` to change the URL slug.
3. Add your site's origin to `ALLOWED_ORIGINS` in `worker.js`.
4. Deploy:
   ```bash
   cd cf-worker
   npx wrangler deploy
   # or: CLOUDFLARE_API_TOKEN=<token> npx wrangler deploy
   ```
5. In FreeGent, open **Settings → Privacy → CORS Proxy / CF Worker URL** and paste the URL it prints.

### Shared keys (optional)

```bash
npx wrangler secret put GROQ_API_KEY        # also OPENROUTER_API_KEY, GEMINI_API_KEY, NOUS_API_KEY,
                                            # TOKENHARBOR_API_KEY, NVIDIA_API_KEY, VERCEL_API_KEY
npx wrangler secret put FG_DEV_KEY          # the Developer key that unlocks them
```

Whether it is acceptable to share a key depends on the provider's terms. Free models on OpenRouter, Groq's free tier, Gemini and Nous are usually fine for server-side use; check yours.

## Limits (Cloudflare free plan)

| | Free | Workers Paid |
|---|---|---|
| Requests | 100,000 per day | 10 million per month |
| Wall time per request | 30 seconds | 30 minutes |

Very long generations on slow models can hit the 30-second limit.
