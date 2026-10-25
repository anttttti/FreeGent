# WebUI: local or self-hosted

The WebUI runs from the dev server on your machine (see [Install](/local/#install)), on other devices through the LAN mode, or from your own static site and Worker.

## Using it from other devices (LAN)

```bash
npm run dev:lan        # all interfaces; add FG_HTTP=1 (npm run dev:lan:http) for plain HTTP
```

On startup the server prints one URL per network address, each carrying an access token (`#fg_token=…`). Open that URL once on each device; the device remembers the token. Without the token the page loads but the server's API (code execution, the proxy, server-held keys) refuses requests.

- The token is stored in `~/.config/freegent/server-token`. Delete the file to issue a new one.
- Set `FG_ALLOWED_ORIGINS=http://192.168.1.50:5000,…` to allow additional origins.
- Do not expose the dev server to the internet. The token is a shared secret, not a user account, and the server can run commands on the machine. See [Security](https://github.com/anttttti/FreeGent/blob/main/SECURITY.md).

## Hosting your own site and Worker

FreeGent builds to plain static files:

```bash
npm run build          # output in dist/
```

Serve `dist/` from any static host. A static host has no `/api/proxy`, no Local code execution and no `run_git`; the in-browser sandboxes still work. Provider calls need a CORS proxy, so deploy the Worker as well.

### Deploy the Worker

FreeGent uses a proxy Worker to enable request types that a browser cannot make on its own:

- **Model calls** to providers that do not allow requests from web pages (NVIDIA, Kilo). On a static host at the Routed privacy level every provider call goes through it, which is also how shared keys are added.
- **Web search** through Brave, and **`fetch_url`** and other plain page requests to sites that do not send CORS headers. The Worker fetches the page and returns it, for public HTTPS addresses only.
- **Optional extras**: shared provider keys for sessions with a Developer key, and chat logs a user chooses to send.

A static site without a Worker still loads, but these requests fail. Providers that do allow browser requests (Gemini, Groq, OpenRouter and others) work directly at the Provider-only level, which is the default.


1. Create a free Cloudflare account.
2. In `cf-worker/wrangler.toml`, delete the `workers_dev = false` and `routes = …` lines. They bind the official Worker to `proxy.freegent.ai` and fail in other accounts. Change `name` if you want a different URL slug.
3. Add your site's origin (for example `https://chat.example.com`) to `ALLOWED_ORIGINS` in `cf-worker/worker.js`. Requests from other origins get `403`.
4. Deploy:
   ```bash
   cd cf-worker
   npx wrangler deploy
   # or, if the browser login cannot reach localhost:
   CLOUDFLARE_API_TOKEN=<token> npx wrangler deploy
   ```
5. In your site, open **Settings → Privacy → CORS Proxy / CF Worker URL** and paste the Worker URL (`https://freegent-proxy.<you>.workers.dev`).

The URL field takes precedence over everything else, so this works on any domain. Without it, a page on a host that is not a known static host calls `/api/proxy` on its own server, which a static site does not have.

If you publish through GitHub Pages under `yourname.github.io`, the app treats that as a static host and uses the official Worker by default, which refuses your origin. Do steps 2 to 5 above.

To allow another provider through the Worker, add its host to `ALLOWED_HOSTS`.

### Optional: shared provider keys

Store keys as Worker secrets and set a Developer key; the Worker then uses the shared keys for sessions that present it.

```bash
cd cf-worker
npx wrangler secret put GROQ_API_KEY       # also OPENROUTER_API_KEY, GEMINI_API_KEY, NOUS_API_KEY,
                                           # TOKENHARBOR_API_KEY, NVIDIA_API_KEY, VERCEL_API_KEY
npx wrangler secret put FG_DEV_KEY         # the Developer key
```

Then paste the Developer key into Settings → Models → API Credentials → Developer key. Without a Developer key the Worker never injects its keys. Use is limited by a per-IP rate limit (`ratelimits` in `wrangler.toml`), and the Worker returns only `true`/`false` per provider from `/keys`, never the key values.

Cloudflare's free plan allows 100,000 requests per day and 30 seconds of wall time per request, enough for most model calls.
