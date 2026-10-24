# Contributing

FreeGent is a TypeScript project (ES modules, no framework) that runs unbundled under Vite in development. Start with [AGENTS.md](https://github.com/anttttti/FreeGent/blob/main/AGENTS.md): it describes the module model, the rules that matter (for example, no raw `fetch` to model APIs, and how to register a new module) and the architecture of the agent loop.

## Set up

```bash
git clone https://github.com/anttttti/FreeGent
cd FreeGent
npm install
npm run dev            # http://localhost:5000
```

## Checks

| Command | What it checks |
|---|---|
| `npm run typecheck` | `tsc` for the app and the Node entry points |
| `npm test` (or `npx vitest run`) | Unit and integration tests in `tests/` |
| `npm run build` | The production bundle (`dist/`) |
| `npm run probe:headless` | That the headless runner loads every module and bridge. Run it after changing bridges or load order. |
| `node bench/smoke/run.js` | End-to-end smoke tasks against a real model |
| `node bench/browser/run.mjs` | The WebUI in a real browser with a scripted model |
| `node scripts/nudge-index.mjs --check` | That `docs/harness/nudges.md` lists every harness nudge and completion gate by name (`--update` regenerates it; a new name also needs a line in `WHEN` in the script) |
| `npx tsx scripts/shiro-inventory.mjs --check` | That `docs/shiro/command-matrix.json` matches the sources (`--update-note` regenerates it; it hashes `headless-runner.ts`, so run it after editing that file or adding a root module) |

[bench/BENCHMARKS.md](https://github.com/anttttti/FreeGent/blob/main/bench/BENCHMARKS.md) ("What tests what") says which check to use when. A defect found by hand gets a unit test, and where it is about the UI, a regression probe in `bench/browser/`.

Structure questions about the code (the longest functions, exports nothing else mentions, import cycles) are answered from the syntax tree by `node scripts/code-index.mjs functions|exports --unused|cycles` (`--root-only` for the files directly in the repository root).

Pull requests run typecheck, tests, build and the headless probe (`.github/workflows/check.yml`).

## Deploying (maintainers)

Do not run `git push` directly. Use `./deploy.sh`, which runs the safety, bug and leak checks first and requires a clean working tree:

```bash
./deploy.sh --check-only     # checks and build, no deploy
./deploy.sh --git-only       # push to GitHub (Pages deploys from main)
./deploy.sh --worker-only    # deploy the Cloudflare Worker
./deploy.sh                  # both
```

The Cloudflare token is read from `CLOUDFLARE_API_TOKEN` or `~/.config/freegent/credentials`, never from the repository.

## Security issues

Do not open a public issue. See [SECURITY.md](https://github.com/anttttti/FreeGent/blob/main/SECURITY.md).
