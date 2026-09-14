# Security Policy

## Scope

FreeGent runs **entirely in the browser**. There is no persistent server that stores user data
or credentials. Specifically:

- **API keys** are stored in `~/.config/freegent/credentials` (or a project `.env`) and
  injected at dev-server startup by `vite.config.ts`. They are never sent to any FreeGent
  server; they go only to the LLM provider endpoints you configure.
- **Chat history and settings** are stored in `localStorage` and (optionally) a local SQLite file
  via the File System Access API — on your device, not remotely.
- **The sandbox iframe** (`fg-sandbox-frame.ts`) executes arbitrary code in an isolated `<iframe
  sandbox>` with a separate origin. This is intentional: user-requested code runs in a separate
  browsing context with no access to the main app's DOM or storage.

There is no multi-user server mode. All data stays in the browser.

## Reporting a vulnerability

Please **do not** open a public GitHub issue for security vulnerabilities.

Open a **private** GitHub Security Advisory on the repository, or send a private email to the maintainer (see the GitHub profile for contact details).

Include:
- A description of the issue and its potential impact
- Steps to reproduce (or a proof of concept)
- The version or commit hash you tested against

You will receive a response within 7 days. We will coordinate a fix and disclosure timeline
with you before publishing anything publicly.

## Known intentional behaviours

- The sandbox iframe executes untrusted code by design (user-written scripts, agent-generated
  code). It is sandboxed via `sandbox="allow-scripts"` with a separate origin and no
  `allow-same-origin`. If you find an escape from this sandbox, please report it.
- The Vite dev server (`npm run dev`) has no authentication. It is intended for local or
  trusted-LAN use only — do not expose it to the public internet.
