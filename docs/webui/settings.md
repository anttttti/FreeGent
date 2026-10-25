# Settings

Settings are stored in your browser. Tabs below follow the order in the app. The TUI and CLI read the same agent settings through profiles and flags; see [Local or self-hosted](/local/).

## Profiles

A profile is a named snapshot of your model list, tools, skills and agent settings. **Save Current** creates one, you can load, export and import them as `.json`, and sharing one never shares API keys.

## Models

- **Model Priority**: the ordered list FreeGent tries. **✦ Populate** asks a model to rank the available ones and keeps the top ten, **Defaults** restores the shipped list and resumes paused models. See [Priority, fallbacks and retries](/models/rotation).
- **Worker Model**: "Default" follows the priority rotation; "Priority model" always uses model #1.
- **Utility Model**: used for chat titles, prompt suggestions and other short side calls. "None" turns titles and suggestions off.
- **Sampling overrides**: temperature, top-p, top-k, min-p, presence and repetition penalty. They apply to custom endpoints only; other providers use their own defaults. A field you have never touched uses FreeGent's default (shown as its placeholder); clear a field and that parameter is left out of the request, so the server uses its own. [Profiles](#profiles) carry these values.
- **API Credentials**: one field per provider, a paste box, **Extract from file**, and the Developer key. See [Default providers](/models/providers). Custom endpoints are added here too.
- **Media Model Routing**: which models receive messages that contain images or audio.
- **Model Catalog**: all known models, with **Check for updates**. Use ✕ to remove one.

## Search

The search provider for `web_search`: **Auto** (Tavily, then Brave, then Wikipedia), Tavily, Brave, or Wikipedia only. Also the optional Brave, GitHub (60 to 5,000 requests per hour) and Stack Exchange (300 to 10,000 per day) keys, and nothing else: the Worker URL override is under [Privacy](#privacy).

## Privacy

Controls where FreeGent may send requests. Change it with **Settings → Privacy** or the **Privacy** button in the sidebar above Dark mode, which shows the current level and explains each option when you point at it. The level is saved in this browser only and is not part of [profiles](#profiles).

Until you choose, the level is **Provider-only**. Saving a Developer key switches it to **Routed**, because the key's shared provider keys only work through the Worker; you can switch back afterwards.

| Level | What it does |
|---|---|
| **Routed** (Cloudflare Worker + endpoint) | On freegent.ai, model requests, web fetches and searches go through FreeGent's Cloudflare Worker, which forwards them and stores nothing. On a local server, providers that need one go through its own proxy, and the rest are called directly. |
| **Provider-only** (no FreeGent.ai or Cloudflare) | Your browser calls the model providers directly. Neither the hosted Worker nor a custom Worker is used, and log uploads and location lookup are off. Providers that do not allow browser calls (NVIDIA, Kilo) are dropped from the rotation on a hosted page, and web fetches and Brave search only work for sites that send CORS headers. On a local server its own proxy is still used, because it runs on your machine and holds the keys from the credentials file. |
| **Local** (local network access only) | Only `localhost` and private-network addresses are reachable, such as Ollama, vLLM or LM Studio and MCP servers on your network. Cloud providers, web search and `fetch_url` are refused, and code the agent runs (JavaScript, Python) and HTML previews cannot call other hosts. |

Switching takes effect at once and re-checks which models are usable. In Local, add a model under **Models → Add custom model**; from freegent.ai the model server must allow the page's origin (Ollama: `OLLAMA_ORIGINS=https://freegent.ai`).

Two limits apply at every level. Libraries the page loads from jsdelivr and esm.sh, and runtimes such as Pyodide, are fetched once and then cached by your browser. In Local, HTML previews can still load images, scripts and styles from the web; only their `fetch` and XHR calls are blocked.

Also on this tab:

- **CORS Proxy / CF Worker URL**: your own Worker, for FreeGent hosted on your own domain (Routed level only). See [Hosting your own site and Worker](/local/webui#hosting-your-own-site-and-worker).
- **Other requests**: location lookup through ipinfo.io (on by default; it sends your IP address to ipinfo.io) and the anonymous GoatCounter page-view counter (on by default, skipped when your browser sends Do Not Track; no cookies). The location lookup is off at Provider-only and Local; the counter is off at Local only.

## Code Execution

JavaScript in the browser (always on), Python in the browser with Pyodide (with an auto-load option), the bash sandbox (**WASM**, **Local** or **None**), **Git Integration** and **Code Structure Queries (AST)**. See [Code execution](/code-execution/).

## Agent

| Group | Options |
|---|---|
| **Context Management** | Tool result truncation for workers and the main agent, proactive compaction and its threshold. See [Context and compaction](/harness/context). |
| **Prompt Construction** | Script-generation steering, concise prompts, and a prompt template that is added at the top of the system prompt |
| **Agent loop** | Max steps per turn, rate-limit cooldown, rotate endpoints every N steps |
| **Workers** | Lean worker context, whether director workers fork the full context, worker output reduce, role model routing, max delegation depth, worker thinking budget, preserve thinking across turns (vLLM). See [Roles and sub-agents](/harness/roles). |
| **QA gates** | Lifecycle gates, acceptance review, test runner, regression guard, rework limit. See [Tasks](/webui/tasks). |
| **Checks** | Edit review for large file changes, tool-call intent validation, tool approval. See [Checks and approval](/harness/checks). |
| **Autonomous Agent Loop** | QA gates after each task, task ledger, message log review, consecutive failure limit |

## Skills, Tools, MCP and Roles

| Tab | What it controls |
|---|---|
| **Skills** | Switch built-in and custom skills and rules on or off, edit triggers, create one in a form, or **Import from file**. See [Skills and rules](/harness/skills). |
| **Tools** | Enable tools separately for [Chat and Cowork](/webui/chats/modes) |
| **MCP** | Connect Model Context Protocol servers and choose which of their tools the agent sees. See [MCP servers](/harness/mcp). |
| **Roles** | View and edit each role's system prompt and tool ceiling; uncheck a role to stop workers using it. **Reset** restores the built-in prompt. |

## Voice

Speech input (STT) and output (TTS) models, tried in order with the first one that has a key. Language, browser voice, speed and pitch, and auto-speak.

## Where your data lives

| Data | freegent.ai | Local server |
|---|---|---|
| Chats, settings, typed keys | your browser | your browser |
| Project files | your browser (IndexedDB), or a folder you connect | your browser, or a folder you connect |
| Keys in the credentials file | n/a | server only |
| Chat logs | not sent unless you choose to send one | same |

Everything stored in the browser is lost when you clear site data. Export projects from [Project](/webui/project/) and profiles from the Profiles tab to keep a copy.

Besides your model provider, the page loads its libraries (marked, DOMPurify, highlight.js, KaTeX, Bootstrap, CodeMirror) from jsDelivr or esm.sh. The two optional requests under [Privacy](#privacy) are the only others, and [Provider-only and Local](#privacy) switch off everything that goes through FreeGent's Worker.
