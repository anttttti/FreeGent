# How requests reach providers

Browsers block most direct calls to model APIs (CORS), and some providers also require the call to come from a server. By default (**Routed**) FreeGent sends calls through a proxy, chosen by where the page is served from:

| Page served from | Provider calls go through |
|---|---|
| `freegent.ai`, `*.github.io`, `*.pages.dev` | The hosted Cloudflare Worker at `proxy.freegent.ai`, for every provider call |
| A local dev server (`localhost`, or a LAN address) | The server's own `/api/proxy`, for providers that block browsers (NVIDIA, Kilo), custom endpoints and web fetches. Gemini, Groq, OpenRouter and Nous are called directly. |
| The CLI or TUI | Direct, no proxy (there is no CORS outside a browser) |

If you fill in **Settings → Privacy → CORS Proxy / CF Worker URL**, that Worker is used instead of the default.

On freegent.ai you never set up a proxy for the [default providers](providers.md); a key is enough, or use the guest quota while it is enabled. Routed is the default and also supports NVIDIA and Kilo, which browsers cannot call directly. Saving a Developer key switches to Routed.

## Turning the Worker off

The sidebar's **Privacy** button and **Settings → Privacy** have two alternatives to the default Routed level that use no Worker:

- **Provider-only**: the browser calls providers directly. This works for Gemini, Groq, OpenRouter, Nous, Vercel, TokenHarbor, MoonMath, Requesty, OpenAI and Tavily, which allow browser calls. NVIDIA, Kilo and Brave search do not, so they stop working on a hosted page, and web fetches only reach sites that send CORS headers.
- **Local**: only `localhost` and local-network addresses; see [Settings → Privacy](../webui/settings.md#privacy).

## The hosted Worker

The Worker forwards `POST` requests only to a fixed allow-list: Gemini, Groq, OpenRouter, Nous, Kilo, NVIDIA NIM, TokenHarbor, Vercel AI Gateway, MoonMath, Requesty, OpenAI, Tavily and Brave. For `GET` (page fetches and searches) it forwards to any public HTTPS address, with responses up to 48 MB. It accepts requests only from the FreeGent sites and local dev ports, applies a per-IP rate limit and stores nothing.

Because any program can call the Worker, its page-fetch path first asks for a [Cloudflare Turnstile](https://developers.cloudflare.com/turnstile/) check. The first page fetch of a session runs it in the background, usually with nothing to see. Cloudflare shows a checkbox only when your browser or network looks unusual. The check gives the page a session token for about four hours, tied to your network. If a content blocker stops `challenges.cloudflare.com`, page fetches through the Worker fail with a message saying so. Provider-only and Local never contact the Worker, so they never run the check.

The Worker can also hold provider keys of its own (Worker keys). They never leave it: the Worker makes requests with them. They serve two cases, both explained in [Access without your own key](access.md): **guest access**, a limited quota on Groq, Kilo, OpenRouter and TokenHarbor for visitors without a key, while FreeGent has it switched on; and the **Developer key**, which gives the Worker's operator all of them.

## When you do need your own proxy or Worker

- **You host FreeGent yourself on a static site.** The hosted Worker only accepts its own origins. A fork on `yourname.github.io` or `*.pages.dev` is treated as a static host and sent to `proxy.freegent.ai`, which answers `403 Origin not allowed`. On any other domain the page assumes a local server and calls `/api/proxy` on its own host, which a static site does not have. Either way, deploy [the Worker](https://github.com/anttttti/FreeGent/blob/main/cf-worker/README.md) to your Cloudflare account, add your origin to `ALLOWED_ORIGINS`, and paste its URL into **Settings → Privacy → CORS Proxy / CF Worker URL**. See [Local or self-hosted](../local/webui.md#hosting-your-own-site-and-worker).
- **You want a provider that is not on the allow-list** from the hosted site. Add its host to `ALLOWED_HOSTS` in your own Worker.
- **You want your own keys used through your Worker, or a guest quota for your visitors.** Store the keys as Worker secrets, set a Developer key, and optionally `FG_GUEST_QUOTA`; see the Worker README.

Your own Worker needs a Turnstile widget for your domain before page fetches work, or `FG_OPEN_RELAY = "1"` if nobody else can reach it; see the Worker README.

## Local models

The hosted Worker cannot reach `localhost` or your LAN, so local model servers need the local dev server, the TUI or the CLI. See [Local models](local-models.md).
