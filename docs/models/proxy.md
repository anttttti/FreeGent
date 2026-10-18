# How requests reach providers

Browsers block most direct calls to model APIs (CORS), and some providers also require the call to come from a server. In the browser FreeGent therefore sends calls that need it through a proxy, chosen by where the page is served from:

| Page served from | Provider calls go through |
|---|---|
| `freegent.ai`, `*.github.io`, `*.pages.dev` | The hosted Cloudflare Worker at `proxy.freegent.ai`, for every provider call |
| A local dev server (`localhost`, or a LAN address) | The server's own `/api/proxy`, for providers that block browsers (NVIDIA, Kilo), custom endpoints and web fetches. Gemini, Groq, OpenRouter and Nous are called directly. |
| The CLI or TUI | Direct, no proxy (there is no CORS outside a browser) |

If you fill in **Settings → Privacy → CORS Proxy / CF Worker URL**, that Worker is used instead of the default.

On freegent.ai you therefore never set up a proxy for the [default providers](/models/providers); a key is enough.

## Turning the Worker off

**Settings → Privacy** has two stricter levels, and neither uses any Worker:

- **Provider-only**: the browser calls providers directly. This works for Gemini, Groq, OpenRouter, Nous, Vercel, TokenHarbor, OpenAI and Tavily, which allow browser calls. NVIDIA, Kilo and Brave search do not, so they stop working on a hosted page, and web fetches only reach sites that send CORS headers.
- **Local**: only `localhost` and local-network addresses; see [Settings → Privacy](/webui/settings#privacy).

## The hosted Worker

The Worker forwards `POST` requests only to a fixed allow-list: Gemini, Groq, OpenRouter, Nous, Kilo, NVIDIA NIM, TokenHarbor, Vercel AI Gateway, OpenAI, Tavily and Brave. For `GET` (page fetches and searches) it forwards to any public HTTPS address. It accepts requests only from the FreeGent sites and local dev ports, applies a per-IP rate limit and stores nothing.

The Worker can also hold shared provider keys, but it uses them only for sessions that present the maintainer's Developer key (Settings → Models → API Credentials → Developer key). Ordinary visitors always use their own keys.

## When you do need your own proxy or Worker

- **You host FreeGent yourself on a static site.** The hosted Worker only accepts its own origins. A fork on `yourname.github.io` or `*.pages.dev` is treated as a static host and sent to `proxy.freegent.ai`, which answers `403 Origin not allowed`. On any other domain the page assumes a local server and calls `/api/proxy` on its own host, which a static site does not have. Either way, deploy [the Worker](https://github.com/anttttti/FreeGent/blob/main/cf-worker/README.md) to your Cloudflare account, add your origin to `ALLOWED_ORIGINS`, and paste its URL into **Settings → Privacy → CORS Proxy / CF Worker URL**. See [Local or self-hosted](/local/webui#hosting-your-own-site-and-worker).
- **You want a provider that is not on the allow-list** from the hosted site. Add its host to `ALLOWED_HOSTS` in your own Worker.
- **You want shared keys for your own users.** Store them as Worker secrets and set a Developer key; see the Worker README.

## Local models

The hosted Worker cannot reach `localhost` or your LAN, so local model servers need the local dev server, the TUI or the CLI. See [Local models](/models/local-models).
