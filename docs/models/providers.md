# Default providers

FreeGent ships with the providers below. One key is enough to start; each extra key adds models to fall back on when a free tier runs out. Any other OpenAI-compatible endpoint can be added as a custom model (see [Local models](local-models.md)).

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
| Zro (MoonMath.ai) | `ZRO_API_KEY` (also `MOONMATH_API_KEY`) | [Free plan](https://zro.moonmath.ai/pricing): daily allowance on DeepSeek V4.1 Flash and GLM-5.3 Flash; key required. Paid plans meter usage. |
| APInex | `APINEX_API_KEY` | Explicit `free/` model routes; account-wide RPM and allowance limits. Some free-labelled models require a subscription. See [models](https://apinex.bond/models). |
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
| freegent.ai | Settings → Models → API Credentials | Stored in your browser |
| Local dev server | `~/.config/freegent/credentials`, or Settings | File keys stay on the server |
| TUI | credentials file, shell variables, or `--api-key` | See [TUI](../local/tui.md) |
| CLI | credentials file, shell variables, or `--api-key` | See [CLI](../local/cli.md) |

API Credentials also has a paste box and an **Extract from file** button. Paste a block of keys (or pick a `.env`-style file) and FreeGent fills each provider's field by recognising the key's prefix. It asks before replacing a key you already saved.

Keys are never included in [profiles](../webui/settings.md#profiles) or in chat logs you send.

Zro uses `https://zro.moonmath.ai/v1/chat/completions`. Its free daily allowance resets each day;
the provider does not publish a token or request limit. Add a key in Settings or set
`ZRO_API_KEY` (or `MOONMATH_API_KEY`) in the credentials file. CLI example: `freegent --provider zro --model deepseek-v4.1-flash`.
For the paste box, use `ZRO_API_KEY=sk-...`; the bare `sk-` prefix is shared by other providers.
The catalog includes only the two models advertised for the Free plan, whose availability was
checked against the [pricing](https://zro.moonmath.ai/pricing) and [API docs](https://zro.moonmath.ai/docs/api)
on 2026-11-01. Authenticated completions and streamed tool-call round trips were verified for both
models on that date. The size of the daily free allowance has not been measured.

APInex uses `https://api.apinex.bond/v1/chat/completions`. Set `APINEX_API_KEY` in the
credentials file or paste `APINEX_API_KEY=...` in Settings. CLI example:
`freegent --provider apinex --model free/glm-5.3-flash`. See the [key setup](https://apinex.bond/keys?tab=setup).
Keep the `free/` prefix: IDs without it can be paid routes.

On 2026-11-01, nine routes returned valid streamed native tool calls: GLM 5.3 Flash,
DeepSeek V4.1 Flash, DeepSeek V4 Pro 0813, GLM 5.3, GLM 5.3 FlashX, Gemini 3.8 Flash,
GPT-6 Luna, Kimi K3, and Qwen 3.8 MAX. The first two also passed completion and tool-result
round-trip checks and full FreeGent file-reading runs (GLM: 3 steps, 8.0 seconds;
DeepSeek: 2 steps, 4.1 seconds). These are gateway model labels; upstream model identities were not verified.
Ten other `free/` routes returned HTTP 402 requiring a subscription and are blacklisted from
the free catalog. Jev needs `/v1/decisions` and discovery filters it out as non-chat.
MiniMax M3.1 Flash ignored a required echo call but passed a subsequent lookup-tool check;
it is available through discovery, unchecked, rather than enabled by default. Newly discovered APInex
routes start unchecked so the `free/` prefix does not silently add subscription-only routes.

The tested account reported 15 RPM across models; other accounts can have different limits.
Successful probes reported zero charged tokens. The daily allowance size was not measured.
Initial background intent checks returned HTTP 500 (temporarily unavailable); subsequent
agent runs completed successfully. Small smoke tests do not establish sustained reliability.
DeepSeek and GLM use the documented `low`, `medium`, and `high` reasoning levels;
FreeGent's Off setting uses `low`, since APInex documents no disabled level.
