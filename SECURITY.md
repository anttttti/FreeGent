# Security Policy

## Components and what each one trusts

FreeGent has four parts, and they have different exposure:

- **The browser app** keeps chat history and settings in `localStorage` / IndexedDB on your
  device. API keys you type into Settings are stored in `localStorage` in plain text, so any script
  running in the page can read them (see *Known limitations*).
- **The dev server** (`npm run dev`, `vite.config.ts` + `dev-api.ts`) runs on your machine and
  serves the app plus an API: `/api/execute` (runs bash/python on your machine, as you),
  `/api/git`, and `/api/proxy` (fetches URLs for the page, to get around CORS).
  - Every `/api/*` request needs a per-install token (`~/.config/freegent/server-token`). On a
    localhost-bound server the token is embedded in the page. On a LAN-bound server
    (`npm run dev:lan`) it isn't: the server prints URLs that carry it (`#fg_token=…`), and each
    device keeps it after opening one.
  - **Keys in `~/.config/freegent/credentials` (or `.env`) never reach the browser.** The page
    gets placeholders; `/api/proxy` substitutes the real key only for HTTPS requests to that
    provider's one API host (`KEY_HOSTS` in `dev-api.ts`, exact match). No endpoint returns key
    values.
  - `/api/proxy` never reaches the dev server itself or a link-local address (cloud metadata),
    on any redirect hop. Its GET form — used for URLs the agent picks (`fetch_url`, previews) —
    reaches public addresses only; the check runs when the connection is made, so DNS rebinding
    doesn't get around it. Its POST form carries your configured LLM endpoints and fixed provider
    hosts, so it can reach local and LAN model servers. The server refuses to start if its port
    is taken, so the port it checks is the port it uses. Request bodies are capped.
  - Commands run through `/api/execute` get an environment without credentials
    (`secret-env.ts`). On Linux with bubblewrap they also run isolated: only system directories
    (read-only), the command's own temp directory, and the toolchains on your `PATH` are visible —
    not your home directory, so not the credentials file, SSH keys or other projects
    (`FG_EXEC_ISOLATION`, `FG_EXEC_BIND`; the server logs which mode it uses). Without bubblewrap
    (macOS, Windows, or user namespaces disabled) commands run as you and can read your files, and
    tool approval defaults to asking before each command.
  - `/api/git` works on this project's repository only. It refuses options that make git run
    other programs, write outside it or read outside it (`-c`, `-C`, `--git-dir`, `--no-index`,
    `clone --config/--template`, `--upload-pack`, `grep -O`, `rebase --exec`, …), and with
    bubblewrap it runs isolated like `/api/execute`, seeing only the repository. The agent's file
    tools can't write inside `.git` (hooks, repo config). Remote operations that need your SSH keys
    or credential helper don't work from the agent — push from your own shell.
- **The CF Worker** (`cf-worker/`) is the CORS proxy for the GitHub Pages site. Shared keys
  stored as Worker secrets are usable by anyone who can send it a request — an `Origin` check
  stops other websites, but other clients can send any header. Their use is bounded by a per-IP
  rate limit (`FG_RATE_LIMITER` in `wrangler.toml`), not by secrecy.
- **The headless runner** (`fg-run.ts`, benchmarks) runs agent commands on the host or in a task
  container. Credentials are removed from command environments; `FG_EXEC_KEEP_ENV=NAME,…` passes
  named variables through when a task needs one.

## Sandboxes

- **Agent code in the browser** — `execute_code` in JavaScript or Python, and the in-browser bash
  shell including its `node`, `js-eval` and `python` commands — runs in the exec sandbox: a hidden
  `<iframe sandbox="allow-scripts">` (`exec-sandbox-host.ts`, `exec-sandbox/`), with Pyodide in a
  worker started from it. Its origin is opaque: it can't read the app's storage (typed API keys,
  chats), DOM or dev-server token, and the dev server refuses its requests. It reaches the
  workspace only through four file operations the page performs for it.
- HTML previews, rendered SVG and the code runner use `<iframe sandbox="allow-scripts">` without
  `allow-same-origin` too. Previews can fetch cross-origin URLs through the page's relay, which
  refuses private addresses and the dev server itself.
- If you find a way out of these sandboxes, please report it.
- Third-party scripts load from jsDelivr at pinned versions with Subresource Integrity hashes.

## Known limitations

- API keys typed into Settings live in `localStorage` in plain text. Agent code can't reach them
  (it runs in the exec sandbox), but a script injected into the page itself could. Keys in the
  credentials file never reach the page.
- The Content-Security-Policy only disables plugin content and `<base>`. Scripts and connections
  are not allowlisted: preview iframes (`srcdoc`) inherit the page's policy, and the pages the
  agent builds load libraries from any CDN.
- Without bubblewrap, `/api/execute` is not isolated (see above).
- The headless runner (benchmarks) runs commands on the host or in a task container without
  bubblewrap; isolate it with the container it runs in.
- The dev server is meant for your machine and networks you control. Don't expose it to the
  internet; the token is a shared secret, not user accounts.

## Reporting a vulnerability

Please **do not** open a public GitHub issue for security vulnerabilities.

Open a **private** GitHub Security Advisory on the repository, or send a private email to the maintainer (see the GitHub profile for contact details).

Include:
- A description of the issue and its potential impact
- Steps to reproduce (or a proof of concept)
- The version or commit hash you tested against

You will receive a response within 7 days. We will coordinate a fix and disclosure timeline
with you before publishing anything publicly.
