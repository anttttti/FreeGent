# Default providers

FreeGent ships with the providers below. One key is enough to start; each extra key adds models to fall back on when a free tier runs out. Without a key, [guest access](access.md#guest-access) may cover Groq, Kilo, OpenRouter and TokenHarbor for a limited number of requests a day. Any other OpenAI-compatible endpoint can be added as a custom model (see [Local models](local-models.md)).

Free-tier limits are set by the providers and change often, so check each provider's page for current numbers. When a model answers `429`, FreeGent puts it on a cooldown and moves to the next one in your [priority list](rotation.md).

| Provider | Variable in the credentials file | Notes |
|---|---|---|
| Google Gemini | `GEMINI_API_KEY` (also `GOOGLE_API_KEY`) | Free tier from [AI Studio](https://aistudio.google.com/app/apikey) |
| OpenRouter | `OPENROUTER_API_KEY` | Many `:free` models |
| NVIDIA NIM | `NVIDIA_API_KEY` | Free API credits at [build.nvidia.com](https://build.nvidia.com) |
| Kilo | `KILO_API_KEY` | `:free` models; needs a key (keyless access ended in 2026-10) |
| Nous Portal | `NOUSPORTAL_API_KEY` (also `NOUS_API_KEY`) | |
| TokenHarbor | `TOKENHARBOR_API_KEY` | Weekly quota |
| Vercel AI Gateway | `VERCEL_API_KEY` | Selected models at $0 per token |
| MoonMath | `MOONMATH_API_KEY` | [Free plan](https://zro.moonmath.ai/pricing): daily allowance on DeepSeek V4.1 Flash and GLM-5.3 Flash; key required. Paid plans meter usage. |
| Requesty | `REQUESTY_API_KEY` | A few $0 models among 800+ priced ones; they work on a $0 balance, about 2 requests at a time. See [models](https://www.requesty.ai/models). |
| Groq | `GROQ_API_KEY` | Rate-limited free tier |
| OpenAI | `OPENAI_API_KEY` | Paid. Also the key slot for any other OpenAI-compatible endpoint you add |
| Hugging Face | `HF_API_KEY` (also `HUGGINGFACE_API_KEY`) | Image generation fallback |
| Ollama, vLLM, LM Studio, any OpenAI-compatible server | none needed | See [Local models](local-models.md) |

Optional keys for tools:

| Tool | Variable |
|---|---|
| Web search (Tavily) | `TAVILY_API_KEY` |
| Web search (Brave) | `BRAVE_API_KEY` |
| GitHub search (raises 60/hr to 5,000/hr) | `GITHUB_TOKEN` |
| Stack Overflow search | `STACKEXCHANGE_API_KEY` |

Web search in **Auto** mode tries Tavily, then Brave, then Wikipedia. Image generation uses Pollinations.ai without a key and falls back to Hugging Face when a key is set.

## Keys and variables

Where a key goes depends on how you run FreeGent:

| You run | Put the key | Notes |
|---|---|---|
| freegent.ai | Settings → Credentials | Stored in your browser |
| Local dev server | `~/.config/freegent/credentials`, or Settings | File keys stay on the server |
| TUI | credentials file, shell variables, or `--api-key` | See [TUI](../local/tui.md) |
| CLI | credentials file, shell variables, or `--api-key` | See [CLI](../local/cli.md) |

For OpenRouter, **Connect** in Settings → Credentials gets a key without copying one: you approve it at openrouter.ai and return with it saved.

API Credentials also has a paste box and an **Extract from file** button. Paste a block of keys (or pick a `.env`-style file) and FreeGent fills each provider's field by recognising the key's prefix. It asks before replacing a key you already saved.

Keys are never included in [profiles](../webui/settings.md#profiles) or in chat logs you send. [Keep your keys safe](key-safety.md) covers who can read a saved key, spending limits, and the optional passkey key lock.

MoonMath (its Zro API) uses `https://zro.moonmath.ai/v1/chat/completions`. Its free daily allowance resets at 00:00 UTC;
the provider does not publish a token or request limit. Add a key in Settings or set
`MOONMATH_API_KEY` in the credentials file. CLI example: `freegent --provider moonmath --model deepseek-v4.1-flash`.
For the paste box, use `MOONMATH_API_KEY=sk-...`; the bare `sk-` prefix is shared by other providers.
The catalog includes only the two models advertised for the Free plan, whose availability was
checked against the [pricing](https://zro.moonmath.ai/pricing) and [API docs](https://zro.moonmath.ai/docs/api)
on 2026-11-01. Authenticated completions and streamed tool-call round trips were verified for both
models on that date. The daily Free allowance is small: one model-ladder conversation with DeepSeek V4.1 Flash used it up
after about 2M tokens (37 requests, 81K context), and the reply named the reset ("It resets in 21h 42m").

**Check for updates** queries authenticated `GET https://zro.moonmath.ai/v1/models`,
deduplicates `zro/` aliases, and checks the two known free-plan model IDs. The API does not
mark free-plan eligibility, so newly added free-plan models need the allowlist updated;
the updater does not automatically assume every accessible model is free.

MoonMath's two Flash routes passed image-reading checks (random six-digit codes) and appear in image-model routing.

## Requesty

Requesty uses `https://router.requesty.ai/v1/chat/completions` with `provider/model` IDs. Set `REQUESTY_API_KEY` in the
credentials file, or paste the key (`rqsty-...`) in Settings. CLI example: `freegent --provider requesty --model novita/ling-3.1-flash`.
Its public `GET /v1/models` lists over 800 models with per-token prices. On 2026-11-01, 13 of them cost $0 for input and output.
Those work on an organization with a $0 balance; priced ones answer `402` "Your organization's balance is too low to run this request".
Streamed tool calls were checked on the free routes the catalog includes: Ling 3.1 Flash (Novita), Nemotron 3 Ultra, Nemotron 3.5
Lightning, Muse Glimmer 30B, Nemotron 3 Nano Omni, Gemma 4 31B and Leanstral 1.5 (a Lean 4 proof model). Muse Glimmer and Nano Omni read
an image with a random code. Gemma 4 is listed with vision but answered `400` to images, so it is text-only. Three $0 routes are listed
but gone upstream (Ling 3.0 Tiny and Nemotron 3 Super: `404`; Nemotron 3 Nano 30B: `410`) and are blacklisted. Two Laguna routes have no
tool support, and Nemotron 3.5 Content Safety is a classifier. Requesty's metadata marks the NVIDIA-served routes as possibly used for
training, with 30-day retention; each catalog note says so.

**Check for updates** reads the public model list and proposes $0 routes with tool support, carrying over their context size and
image and reasoning flags. `reasoning_effort` is sent on every Requesty model. Off sends `none`, which Requesty documents for all models.

Requesty has **no per-minute limit**. It caps the requests an organization has *in flight*: the balance rounded up to the next dollar,
times 5 for the lowest tiers ([in-flight limits](https://docs.requesty.ai/features/in-flight-rate-limits)). At a $0 balance, two of
eight parallel requests went through on 2026-11-01. The others got `429` "Your organization reached its limit of concurrent requests",
with no `Retry-After`. FreeGent retries after 5 seconds and holds every Requesty model for those seconds, since the limit is shared.
With "one request per endpoint" on (the default), each model sends one request at a time.
A key's monthly spend limit answers `412` "Reached monthly spend limit for API key"; every Requesty model then waits an hour and is
checked again, because the end of the cycle is not reported. Free models also share an undocumented budget: after about 15M tokens in two hours (model ladder, 2026-11-01) every $0 route
answered `429` "You've hit the rate limit for free models", with no `Retry-After` or reset time. FreeGent then cools all Requesty
models together for an hour at a time: the limit still held more than an hour after it was hit. Upstream rate limits (`429` "Too many requests", origin `provider`) cool
only that model, as for any provider. Requesty allows browser calls (`Access-Control-Allow-Origin: *`).

## Quota errors for MoonMath

MoonMath uses the shared retry engine, preserving HTTP status and provider error text.
The [MoonMath API reference](https://zro.moonmath.ai/docs/api) documents `402` for exhausted
spend quotas or plan budgets and `429` for rate limits. A quota error cools both MoonMath
models until the reset named in the message, else until 00:00 UTC: the
[pricing page](https://zro.moonmath.ai/pricing) says only that the Free plan's allowance
"resets every day", and the account console showed "Today's Free usage: 89% left · resets in 1h 2m"
at 22:58 UTC on 2026-11-01. The console shows the allowance only as a percentage; it held about 2M tokens.
A key can also carry its own spend limit (Key controls on the API keys page). Reaching it returns
`402` `key_quota_exceeded` ("This API key has reached its spend limit") even while Free usage is left;
FreeGent re-checks that hourly, since the owner can raise the limit at any time.
The Free plan also runs at most **two requests at once per key**
(`x-ratelimit-api_key-limit-max_parallel_requests: 2`). A third gets `429` "The Free plan runs a
limited number of requests at once" with `Retry-After: 60`; a slot frees as soon as one request
finishes, so FreeGent retries that model after 5 seconds and does not cool the other one.
With "one request per endpoint" on (the default), two MoonMath models at most are in flight.

## Removed: APInex

APInex (`api.apinex.bond`) was added and removed on 2026-11-01. Its `free/` routes need a daily check-in on its site, behind a
CAPTCHA, before they answer, and the free allowance (20M weighted tokens a day, about 5 to 10M real tokens) ran out within one
model-ladder conversation at 153K context (GPT-6 Luna: 12 of 21 microtasks). Saved APInex keys, models and priority-list entries are
dropped on load.
