# Default providers

FreeGent ships with the providers below. One key is enough to start; each extra key adds models to fall back on when a free tier runs out. Any other OpenAI-compatible endpoint can be added as a custom model (see [Local models](/models/local-models)).

Free-tier limits are set by the providers and change often, so check each provider's page for current numbers. When a model answers `429`, FreeGent puts it on a cooldown and moves to the next one in your [priority list](/models/rotation).

| Provider | Variable in the credentials file | Notes |
|---|---|---|
| Google Gemini | `GEMINI_API_KEY` (also `GOOGLE_API_KEY`) | Free tier from [AI Studio](https://aistudio.google.com/app/apikey) |
| OpenRouter | `OPENROUTER_API_KEY` | Many `:free` models |
| NVIDIA NIM | `NVIDIA_API_KEY` | Free API credits at [build.nvidia.com](https://build.nvidia.com) |
| Kilo | `KILO_API_KEY` | `:free` models; works without a key at an anonymous rate limit |
| Nous Portal | `NOUSPORTAL_API_KEY` (also `NOUS_API_KEY`) | |
| TokenHarbor | `TOKENHARBOR_API_KEY` | Weekly quota |
| Vercel AI Gateway | `VERCEL_API_KEY` | Selected models at $0 per token |
| Groq | `GROQ_API_KEY` | Rate-limited free tier |
| OpenAI | `OPENAI_API_KEY` | Paid. Also the key slot for any other OpenAI-compatible endpoint you add |
| Hugging Face | `HF_API_KEY` (also `HUGGINGFACE_API_KEY`) | Image generation fallback |
| Ollama, vLLM, LM Studio, any OpenAI-compatible server | none needed | See [Local models](/models/local-models) |

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
| TUI | credentials file, shell variables, or `--api-key` | See [TUI](/local/tui) |
| CLI | credentials file, shell variables, or `--api-key` | See [CLI](/local/cli) |

API Credentials also has a paste box and an **Extract from file** button. Paste a block of keys (or pick a `.env`-style file) and FreeGent fills each provider's field by recognising the key's prefix. It asks before replacing a key you already saved.

Keys are never included in [profiles](/webui/settings#profiles) or in chat logs you send.
