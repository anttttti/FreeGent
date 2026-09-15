# FreeGent CORS Proxy — Cloudflare Worker

A thin passthrough worker that adds CORS headers so the GitHub Pages version of
FreeGent can reach LLM providers (OpenCode, Kilo, NVIDIA, TokenHarbor, Vercel)
that don't allow direct browser requests.

## Deploy your own (5 minutes, free)

1. **Create a free Cloudflare account** at [cloudflare.com](https://cloudflare.com) if you don't have one.

2. **Deploy:**
   ```bash
   cd cf-worker
   npx wrangler deploy
   ```
   Wrangler will open a browser login on first run. After deploying you'll see:
   ```
   Published fg-proxy (https://fg-proxy.<your-subdomain>.workers.dev)
   ```

3. **Configure FreeGent:**  
   Open [FreeGent on GitHub Pages](https://anttttti.github.io/FreeGent/), go to  
   **Settings → Search / CORS Proxy** and paste your Worker URL.

That's it — all proxied providers (OpenCode, Kilo, NVIDIA NIM, TokenHarbor,
Vercel AI Gateway) will now work from the browser.

## Privacy

The Worker is a pure passthrough. It forwards requests to the target URL and
returns the response — nothing is logged, stored, or inspected. API keys in
`Authorization` headers go directly to the LLM provider.

## Free-tier limits

| Limit | Free plan | Workers Paid ($5/mo) |
|---|---|---|
| Requests | 100 000 / day | 10 million / month |
| Wall time per request | 30 seconds | 30 minutes |

The 30-second limit covers the vast majority of LLM calls. Very long generations
on slow models may time out; upgrade if that's an issue.

## Rename the worker

Edit `name` in `wrangler.toml` before deploying to change the URL slug from
`fg-proxy` to something else.
