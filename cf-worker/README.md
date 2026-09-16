# FreeGent CORS Proxy — Cloudflare Worker

A thin passthrough worker that adds CORS headers so the GitHub Pages version of
FreeGent can reach LLM providers that don't allow direct browser requests.

It also supports **shared API key injection**: store your own Groq, OpenRouter,
Cerebras, Gemini, or Nous keys as Cloudflare secrets, and GitHub Pages users can
use those providers without configuring their own keys.

## Deploy your own (5 minutes, free)

1. **Create a free Cloudflare account** at [cloudflare.com](https://cloudflare.com) if you don't have one.

2. **Deploy:**
   ```bash
   cd cf-worker
   npx wrangler deploy
   ```
   If `wrangler deploy` opens a browser but localhost refuses the connection,
   use an API token instead:
   ```bash
   CLOUDFLARE_API_TOKEN=<your-token> npx wrangler deploy
   ```
   After deploying you'll see:
   ```
   Published fg-proxy (https://fg-proxy.<your-subdomain>.workers.dev)
   ```

3. **Configure FreeGent:**  
   Open [FreeGent on GitHub Pages](https://anttttti.github.io/FreeGent/), go to  
   **Settings → CORS Proxy / CF Worker URL** and paste your Worker URL.

That's it — all proxied providers (OpenCode, Kilo, NVIDIA NIM, TokenHarbor,
Vercel AI Gateway, and, if configured, Groq / OpenRouter / Cerebras / Gemini /
Nous) will now work from the browser.

## Optional: shared API keys

Store your API keys as Cloudflare secrets so GitHub Pages users can use those
providers without configuring their own keys. Keys are stored encrypted — never
in the Worker code or the repository.

```bash
# Run once per key you want to share (prompts for the value securely):
npx wrangler secret put OPENROUTER_API_KEY
npx wrangler secret put GROQ_API_KEY
npx wrangler secret put CEREBRAS_API_KEY
npx wrangler secret put GEMINI_API_KEY
npx wrangler secret put NOUS_API_KEY
```

**How it works:**
- On startup, FreeGent calls `GET /keys` on the Worker to discover which
  provider keys are available.  The response is `{"GROQ_API_KEY": true, ...}` —
  the actual key values are never sent to the browser.
- When the client makes an LLM request without an `Authorization` header (or
  with an empty one), the Worker injects the matching secret before forwarding.
- If a user has configured their own API key in browser settings, that key wins;
  the Worker only injects when the client sends nothing.

**Which providers allow shared key use:**
| Provider | Shared key OK? | Notes |
|---|---|---|
| OpenRouter | ✅ | Free models cost nothing; paid credits needed for paid models |
| Groq | ✅ | Generous free tier; server-side use is fine |
| Cerebras | ✅ | Free tier |
| Gemini | ✅ | Google recommends server-side key use |
| Nous | ✅ | Free tier |
| Mistral | ❌ | ToS prohibits shared / multi-user key patterns |

## Security

- **Origin check:** only requests from allowed browser origins (GitHub Pages,
  localhost dev ports) are accepted.  Direct curl calls from unknown origins
  are rejected with 403.
- **Domain allowlist:** the target URL must be a known LLM or search provider.
  Arbitrary URL forwarding is not possible.
- **Secrets never leave:** `/keys` returns only `true`/`false` per provider —
  the actual key values are never sent to the browser.

## Privacy

The Worker is a pure passthrough. Nothing is logged, stored, or inspected.
API keys (user's own or injected from env) are forwarded directly to the
provider and are never retained.

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
