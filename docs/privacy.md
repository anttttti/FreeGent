# Privacy

FreeGent has no accounts and no database of its own for users. This page lists what stays on your device, what leaves it, where it goes, and how to turn each part off. The code behind every statement is in this repository.

## What stays in your browser

- **API keys** you type into Settings. They are stored in `localStorage` as plain text, so anything that can run script in the page can read them. Agent code runs in a sandbox that cannot. See [Security](https://github.com/anttttti/FreeGent/blob/main/SECURITY.md#known-limitations).
- **Chats, project files, the task board and settings.** They live in the browser's storage (IndexedDB and `localStorage`) for the site you opened.
- **Downloaded runtimes.** Libraries, Pyodide and the WebAssembly packages are fetched once and cached.

Clearing the site's data in your browser removes all of it. If you run FreeGent on your own machine, keys in `~/.config/freegent/credentials` stay on the dev server and never reach the page.

## What leaves your device

| What | Where it goes | When |
|---|---|---|
| Prompts, chat history, tool results, and file contents the agent reads | The model provider you chose, with your key | Every model call. The provider's own privacy terms apply, and some free tiers allow the provider to use prompts to improve their products. Check the terms of each provider you use. |
| The same requests | Through FreeGent's Cloudflare Worker (`proxy.freegent.ai`) first | Only at the **Routed** level. The Worker forwards the request and stores nothing. Cloudflare, which runs it, handles the traffic like any host. |
| Search queries and fetched URLs | Tavily, Brave, Wikipedia, GitHub or Stack Exchange; or the site being fetched | When the agent uses `web_search` or `fetch_url`. Never at the **Local** level. |
| Requests to MCP servers you added | Those servers | When the agent uses their tools |
| Library and runtime downloads | jsDelivr and esm.sh (libraries, Pyodide); `cdn.wasmer.io` and `uutils.org` (WebAssembly packages, fetched on first use and checked against pinned hashes) | When the page or a command first needs them |
| A page-view count | GoatCounter, a cookie-free counter | On by default at Provider-only and Routed. Off when your browser sends Do Not Track, at the Local level, or when you clear the checkbox in **Settings → Privacy**. |
| Your IP address | ipinfo.io. The city, region and ISP it returns are added to prompts, so the model provider also sees them. | Only at the Routed level, and only if the location lookup in **Settings → Privacy** is on (it is by default). |
| A chat log | FreeGent's Worker, kept for 14 days and read by the maintainer for debugging | Only when you press **Send log to developer**. Saved keys and any key-like values in the chat are removed first. Not available at Provider-only or Local. |

Two more things apply only to the maintainer's own sessions: a Developer key enables uploads of console errors and finished Autopilot chats, and project sync to a Cloudflare bucket. Ordinary visitors never send either.

## The three privacy levels

Change the level with the **Privacy** button in the sidebar or under **Settings → Privacy**. Until you choose, FreeGent uses Provider-only.

| Level | Model calls | Everything else |
|---|---|---|
| **Provider-only** (default) | Straight from your browser to the provider | No Worker. No location lookup and no log uploads. The page-view counter is on. |
| **Routed** | Through FreeGent's Worker | Location lookup, page-view counter and log sending are available. |
| **Local** | Only to `localhost` and private-network addresses (Ollama, vLLM, LM Studio) | Cloud providers, web search and `fetch_url` are refused. No page-view counter. Libraries and runtimes you have not yet cached still download. |

Details are in [Settings → Privacy](webui/settings.md#privacy) and [How requests reach providers](models/proxy.md).

## Running it yourself

Hosting your own copy or running the dev server, TUI or CLI keeps all of the above under your control. You choose the providers, there is no hosted Worker unless you set one up, and the page-view counter and location lookup can be removed. See [Local or self-hosted](local/index.md).

## Questions and reports

For a security problem, follow [SECURITY.md](https://github.com/anttttti/FreeGent/blob/main/SECURITY.md). For anything else about privacy, open an issue on the repository.
