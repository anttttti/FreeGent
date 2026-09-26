# FreeGent — Agent instructions

## What FreeGent is

Browser-based WebUI for running code and work agents against **free public LLMs** (Gemini free tier, OpenRouter, NVIDIA, Groq, Mistral, Cerebras, and more) and **local LLMs** via Ollama / LM Studio / vLLM (7B–70B, 4k–32k context). Every architectural choice prioritises context budget and reliability on weak models.

## Module model — fully ESM + single-owner domain modules

The ESM migration is COMPLETE: every file is an ES module (`<script type="module">` in
`index.html`). Cross-file access uses the **window bridge**: each module ends with
`Object.assign(window, {…})`, and sibling modules read shared functions as free variables
(declared `any` in `globals.d.ts`, which makes unknown names tsc errors). Shared mutable
state lives in `state.ts` (~21 vars, each `export let X` + `setX()` setter + a
`globalThis` defineProperty bridge). Never reassign a state var as a free variable from
a module — use the setter.

**Domain modules**: any concern used by more than one loop/caller has a
single-owner module — payload-builder, detectors, turn-protocol, tool-call-repair,
history, model-router, stream-decode, retry, history-convert, step-validator,
nudge-emitter. Per-turn state (rotation counters, seen-maps, protocol counters) is owned
by the loop and injected as a parameter object; domain modules hold no per-turn state.

**Registering a new module — four places, always:**
1. `index.html` — `<script type="module" src="foo.ts">` tag
2. `headless-runner.ts` — `import './foo.js';`
3. `tests/setup.js` — `await import('../foo.ts');`
4. `globals.d.ts` — a `// ── bridged by foo.ts ──` section for its bridge names

**Headless (benchmarks)**: `headless-runner.ts` imports the same modules into a JSDOM
window via `bootstrap-jsdom.ts`'s windowProxy (writes to `window` mirror to
`globalThis`). There is no eval-loading anywhere — tests import real modules too.
`npm run probe:headless` boots the chain and verifies cross-module visibility; run it
after touching bridges or load order.

## Hard rules

- **Module kind is per-file** — ES modules import each other; classic scripts use the window
  bridge. Do NOT add bare `import` to a classic script or free-variable reassignments of
  state vars to a module (use the `state.ts` setters). New files should be ES modules.
- **No bundle step** — the app is served by the Vite dev server (`vite.config.ts`), which
  transpiles `.ts` on the fly; there is no production bundling. Docker/headless runs source
  `.ts` via Node `--experimental-strip-types` — no TypeScript-only runtime syntax (e.g.
  constructor parameter properties) in files on that path.
- **No raw `fetch(...)` to LLM APIs** — use `callLLMComplete` or the streaming loops (see below).
- **`buildSystemPrompt()` runs on every LLM request** — keep it cheap; don't cache its output.
- **All history uses OAI format.** `openaiHistory` is the single canonical format: `{role: 'user'|'assistant'|'system'|'tool', content}`. Gemini requests are converted from OAI format at call time. Workers get their own local history; they never share the module-level array.
- **Tool results go through `truncateResultForHistory()` before history storage** (`llm-loops.js`). Add a truncation case there for any new tool that can return large results.

## Key global mutable state (state.ts)

Owned by `state.ts` (ES module): ~21 shared vars, each with `export let X` + `setX()` setter +
a `globalThis` bridge (unused since all files are modules). Highlights:

| Variable | Purpose |
|---|---|
| `openaiHistory` | Director conversation history (OAI format; converted for Gemini at call time) |
| `activePlaceholder` | Current chat response container; null between turns |
| `activeAbortController` | Stop-button AbortController; null between turns |
| `agentBreaking` | True while a break (partial stop) is in progress |
| `mainAgentRole` | Active main-agent role (Agent by default; Director after handover) |
| `currentTurnSkills` / `_reactiveFired` | Per-turn skill trigger state |

## LLM call architecture

### One-shot text completions — `callLLMComplete` (workers.js)

**All background LLM calls must go through `callLLMComplete`.** It handles provider routing, retry logic via `withRetry` + `_makeOAIRetryHandler`, model fallback, proxy support, and stepbox UI visibility.

```js
callLLMComplete(prompt, { temperature, maxTokens, endpoint, label }, handle)
```

- `endpoint` — override with a specific `{provider, url, key, model}` object; null = active main model.
- `label` — stepbox label, e.g. `'worker:review:review'`. Parsed by `_friendlyLabel` in `chat-render.js`.
- `handle` — null: creates stepbox from `activePlaceholder`, owns lifecycle (complete/abort). Provided: sets model/request/output on existing handle; caller owns lifecycle.
- Always adds `chat_template_kwargs: { enable_thinking: false }` for custom endpoints to prevent thinking tokens consuming the budget silently.

Convenience wrappers (both delegate to `callLLMComplete`):
- `callMainModelText(prompt, opts)` — active main model; used by qa.js, chat-state.js.
- `callWorkerModelText(prompt, opts, handle)` — resolves `getWorkerModel()` first.

### Streaming agentic loops (llm-loops.js) — the only exception

These manage their own streaming fetch because token-by-token display and mid-stream tool-call parsing require it:
- `runTurn(endpoint, placeholder, {forWorker, toolFilterOverride})` — the unified main agent
  loop (`llm-loops.ts`); provider differences are inline branches (`_isGoogleStep`). The former
  shared protocol blocks live in `_handleTurnState` and `_runToolCalls`.
- `runWorkerTurn(task, context, handle, workerSpec, role)` — single worker execution
  (workers.ts); local history, shares `_runToolCalls` + detectors.
- Step-output validation (pseudo tool calls, missing state line, narration, user-directed
  questions) runs through the shared three-band engine in `step-validator.ts`.

### Retry infrastructure (llm-shared.js)

- `withRetry(fn, onRetry, maxAttempts, isTransientOverride)` — core retry loop.
- `_makeOAIRetryHandler({getEp, setEp, onNote, onContextOverflow, ...})` — handles 429s, server errors, model rotation, context overflow for OAI calls.
- `_makeGeminiRetryHandler({getModel, setModel, onNote, ...})` — same for Gemini.
- `parseContextOverflow(e)` — extracts available token headroom from vLLM/OpenAI overflow error messages.

### Context management

- Compaction triggers when `estimateTokens(history) > _compactThreshold()` or when a turn hits the output token limit (discard response, set `_forceCompact = true`, retry).
- `compactHistory(placeholder, activeEndpoint)` in `llm-shared.ts`.
- Context overflow on custom endpoints: `callOAI` proactively clamps `max_tokens = min(configured, contextWindow − estimatedInput − 512)`.

### Nudge injection

Framework messages injected mid-conversation use role to carry the signal where supported:
- `_nudgeRole(provider)` returns `'system'` for `nvidia` only (raw ChatML API). All others including `custom` (vLLM/HuggingFace) use `'user'` — HF chat templates (e.g. Qwen3) forbid system messages after turn 0.
- When role is `'user'`, wrap text in `<note>...</note>` tags via the `_nudge` closure in `llm-loops.ts`.

### Thinking levels

`getThinkingLevel()` → `'off'|'low'|'medium'|'high'` (stored in `fg_thinking_level`). `thinkingLevelBudget(provider)` maps to provider-specific token budget numbers. Use these; do not add new per-provider thinking flags.

## Worker architecture (workers.js)

- `executeWorkers(args)` — spawns parallel `runWorkerTurn` calls, applies staged file writes, resolves conflicts, optionally synthesises outputs.
- `resolveFileConflicts(conflicts, snapshot, handle)` — LLM-assisted 3-way merge. Pass the outer stepbox handle to avoid a redundant sub-step.
- `reduceWorkerOutputs(outputs, handle)` — synthesis LLM call. Pass the outer `reduceHandle`.
- Worker model resolution: `getWorkerModel()` → first non-paused entry in the worker model list, or empty string (falls back to main model).
- `resolveWorkerModelSpec(spec, role)` — resolves a spec string or role to a concrete `{provider, url, model}` endpoint.

## Stepbox handle contract

Every LLM step in the UI is represented by a handle with these methods:
`setModel(str)`, `setPrompt(str)`, `setRequest(str)`, `setOutput(str)`, `append(chunk, type)`, `setTokens(in, out)`, `complete()`, `abort()`, `markCompact()`.

`activePlaceholder.addToolStep(labels)` returns an array of handles. Labels starting with `worker:` render as `[N] Role · Jobname`; others fall through to pattern matching in `_friendlyLabel` (`chat-render.js`).

## File routing (workspace.js)

- `local/<name>` — File System Access API (real filesystem). Requires directory grant.
- Bare `<name>` — IndexedDB workspace.
- `agentWriteFile`, `agentReadFile`, `agentListFiles`, `agentDeleteFile` handle the routing. Writing `AGENTS.md` auto-calls `loadAgentsContext()`; writing `roles/*` auto-calls `loadRoles()`; writing `skills/*` auto-calls `loadSkills()`.

## Skills

### Storage

Skills live in `skills/<name>/SKILL.md` (workspace or `local/`) or as entries in `BUILTIN_SKILLS` in `skills.js`. File skills are reloaded automatically when a `skills/*` path is written.

### SKILL.md frontmatter schema

```yaml
---
name: my-skill          # required — unique slug, matches the directory name
description: One-liner shown in the UI skills list and in the ## Skills section of the system prompt.
trigger: keyword, another phrase   # optional — substring match against user message (case-insensitive)
trigger_on_filetype: .py, .ipynb   # optional — fire when message mentions OR workspace contains a file with this extension; append :msg to restrict to message only (e.g. ".py:msg")
trigger_on_tool: execute_code, write_file=>needle  # optional — fire after a tool ran; "tool=>needle" fires only if result contains `needle` (string) or satisfies a comparison: "tool=>field!=0", "tool=>field==value", "tool=>field>n"
trigger_on_failure: http_error x3  # optional — fire after N classified failures in a turn (http_error, tool_error); default threshold is 2
trigger_on_event: session-start, task-start  # optional — lifecycle events: session-start (first message), task-start (task-completion request)
trigger_on_media: audio, pdf               # optional — fire when the message includes an attachment of this type: image | audio | video | pdf | file (text attachment)
trigger_on_message_pattern: Traceback|Error  # optional — regex against the raw user/turn message
trigger_on_history_tool: run_workers         # optional — fire when this tool appears anywhere in history
trigger_on_turn: first                       # optional — fire on the first turn only
trigger_on_repeat: read_file x8              # optional — fire when a tool repeats N times within a turn
trigger_on_file_present: fg-tasks/           # optional — fire when the workspace contains this path
trigger_on_completion: edit|triggered|blocked|always  # optional — fire once when the model declares COMPLETED/BLOCKED (completion gate)
exclude_roles: agent, director               # optional — never fire for these main-agent roles
requires_tools: execute_code                 # optional — skip if any listed tool is disabled
type: rule                                   # optional — 'rule' = standing context, not a procedure
roles: coder, researcher  # optional — auto-injects body into worker system prompts for these roles regardless of trigger
requires: fg_some_setting  # optional — localStorage key that must equal 'true' for the skill to activate
---

## Skill body

Everything after the frontmatter is the skill body — injected verbatim into the system prompt as a `### Active skill: name` block.
```

### Injection lifecycle

| Set | Contents | When populated |
|---|---|---|
| `activeSkills` | Always-on skills toggled on by the user | Persisted in `fg_active_skills`; loaded at startup |
| `currentTurnSkills` | `activeSkills` ∪ keyword-triggered matches | Rebuilt at start of each turn in `agent-core.js` |

**Trigger matching** (`agent-core.js`): five passes run at the start of each turn, in order:
1. **keyword (`trigger`)** — substring match against lower-cased user message
2. **filetype (`trigger_on_filetype`)** — checks message text for the extension string AND (unless `:msg` suffix) checks workspace file extensions from the DOM (`.workspace-file-row[data-filename]`). Multi-part extensions like `.test.js` are matched against both the last and second-to-last dot segments.
3. **lifecycle (`trigger_on_event`)** — `session-start` fires on the first message of a session; `task-start` fires when `_isTaskCompletionRequest()` returns true.
4. **media (`trigger_on_media`)** — fires when the user's message includes an attachment of the specified type. Values: `image` (any image), `audio`, `video`, `pdf`, `file` (text file attachment). Checked before `clearImageAttachments()` so attachment state is still live.
5. **reactive (`trigger_on_tool` / `trigger_on_failure`)** — fires *mid-turn* after tool results are appended, injected as a `_nudge`. `trigger_on_tool: tool=>needle` fires when a tool ran and its result contains `needle`. `trigger_on_failure: http_error x3` fires when N classified failures accumulate in the turn.

`requires` check: if `localStorage.getItem(s.requires) !== 'true'` the skill is skipped even if triggered.

**Injection location**: always-on (`activeSkills`) bodies stay in the system prompt (stable prefix, cache-friendly). Keyword/filetype/lifecycle-triggered bodies are prepended to the user message as `<active_guidance>…</active_guidance>` via `buildTriggeredGuidance()`. Reactive guidance is injected inline as a nudge. A shared context budget caps total injected text.

Role injection (`workers.js` → `_roleSkillBodies(roleName)`): skills with a matching `roles` value are concatenated into worker system prompts via `buildWorkerSystemPrompt()`, independently of `currentTurnSkills`.

`currentTurnToolExtras` — parallel set for keyword-triggered **tool groups** (e.g. `context7` adds two tools to the active tool list for that turn only).

**Add a skill:**
1. Create `skills/<name>/SKILL.md` with the frontmatter above and a skill body
2. Add `name` to `Skills` tab in the UI to make it toggleable (it auto-appears via `loadSkills()`)
3. If the skill needs a tool that doesn't exist yet: follow **Add a tool** first
4. If activation should require a setting flag: add a `requires: fg_<key>` line and ensure the key is set in `settings-ui.js`
5. Test: send a message containing one of the trigger terms and confirm `currentTurnSkills` includes the name (add a `console.log` in `agent-core.js` or check the system prompt via browser devtools)

## Key files

- `state.ts` — the ~21 shared mutable vars + setters + globalThis bridge
- `config.ts` — settings getters (`ls(key, default)` with read cache), model catalog, `ALL_TOOL_NAMES`
- `tool-schemas.ts` — `TOOLS_SPEC`, `activeTools()`, `execToolSpec()` (split out of tools.js)
- `tools.ts` — `executeToolAsync()` dispatch + tool implementations, edit/patch/approval helpers
- `system-prompt.ts` — `buildSystemPrompt()` (split out of tools.js)
- `skill-guidance.ts` — trigger evaluation, `buildTriggeredGuidance()`, `reactiveSkillGuidance()`, `completionGateGuidance()`
- `step-validator.ts` — three-band output validation engine + `AGENT_TOOL_NAMES` canonical list
- `llm-loops.ts` — `runTurn()`, `_handleTurnState()`, `_runToolCalls()`, `_STEP_CHECKS`, nudge helpers, `truncateResultForHistory()`
- `llm-shared.ts` — `withRetry()`, retry handlers, compaction, `specToEndpoint()`, `oaiEndpoint()`
- `workers.ts` — `callLLMComplete()`, `executeWorkers()`, `runWorkerTurn()`, roles, diff/merge utils
- `agent-core.ts` — `agentSend` entry point, checkpoint system, per-turn skill/tool trigger evaluation, Agent→Director handover
- `search-providers.ts` — web-search backends (split out of tools.js)
- `chat-render.ts` — `createTask()` stepbox rendering, `_friendlyLabel()` label → display name
- `settings-ui.ts` — settings form, `updateActiveModelDisplay()`, `applyHdrReasoning()`
- `profiles.ts` — `PROFILE_KEYS`, `profileApply()` — **credentials must never be in `PROFILE_KEYS`**
- `dev-api.ts` — the dev/preview server's `/api/*` (token check, `/api/proxy` with server-key
  substitution and the self-target guard, `/api/execute`, `/api/git`) and the page script that
  wraps `fetch`. **Credential values never go to the browser**: the page holds placeholders
  (`__fgsk__fg_x_key__`). A new provider needs its hosts in `KEY_HOSTS`, or its server key won't
  be substituted. `secret-env.ts` strips credentials from command environments.
- `exec-sandbox-host.ts` + `exec-sandbox/` — **agent code never runs in the page's origin.**
  Browser `execute_code` (JS, Pyodide) and the WASM shell run in an opaque-origin iframe whose
  bundle (`fg-exec-sandbox.js`) is built by `dev-api.ts buildExecSandbox()`. Don't add `eval` /
  `new Function` / same-origin workers for agent-supplied code in page modules; add a runner to
  `exec-sandbox/entry.ts`. New workspace needs from the frame go in `WS_OPS`.
- `/api/proxy` policy: **GET** is for URLs the agent can influence and reaches public addresses
  only; **POST** reaches private addresses too, for configured LLM endpoints. Never route an
  agent-chosen URL through the POST form.
- `workspace.ts` — file I/O routing, checkpoint storage, `agentWriteFile/ReadFile/ListFiles/DeleteFile`
- `headless-runner.ts` / `fg-run.ts` — Node/JSDOM benchmark entry (run with `npx tsx fg-run.ts`)

## Environment detection and system-prompt construction

FreeGent runs in three distinct execution environments. The system prompt is built dynamically from environment detection — never hardcode language or path descriptions.

### Detection globals

| Global | Type | Meaning |
|---|---|---|
| `nativeExec` | function \| undefined | Present in headless (Node/JSDOM) only; absent in browser |
| `fgTargetContainer` | string \| undefined | Non-empty string when agent runs inside a Docker task container (set by `fg-run.ts`); undefined or `''` in native headless |
| `pyodideStatus` | string | `'ready'` or `'loading'` when Pyodide is loaded in the browser |

### Environment matrix

| Environment | `nativeExec` | `fgTargetContainer` | execute_code languages |
|---|---|---|---|
| Browser (no Pyodide) | absent | — | JavaScript only |
| Browser (Pyodide) | absent | — | Python (Pyodide) + JavaScript |
| Native headless | present | falsy | Python, bash, Node.js |
| Docker task container | present | non-empty string | Python, bash, Node.js |

### Helper functions (`system-prompt.ts`)

All three are on the window bridge and declared in `globals.d.ts`:

- **`_buildWorkspaceDesc()`** — one-sentence description of where files live and how to reference them (IndexedDB `local/` prefix vs native path vs container path). Used in the main `buildSystemPrompt()` path.
- **`_buildLangsDesc()`** — "Languages: …" string listing execute_code languages for the current environment. Returns `''` if execute_code is not in enabledTools. Used by `_buildEnvContext()` and the main `buildSystemPrompt()` IIFE.
- **`_buildEnvContext()`** — `\n## Environment\n…` block for the `mainAgentRole` path and worker system prompts. Returns `''` in browser (native detection is the signal).

### Usage points

- **Main agent (no role)**: `buildSystemPrompt()` calls `_buildWorkspaceDesc()` for `## Workspace` and `_buildLangsDesc()` inline in the execute_code bullet.
- **Main agent (role active)**: `buildSystemPrompt()` calls `_buildEnvContext()` and appends it after the role body.
- **Workers**: `buildWorkerSystemPrompt()` in `workers.ts` calls `_buildEnvContext()` for every worker role.

### Design rule

**Never hardcode language or path descriptions in task prompts, skill bodies, or role bodies.** The system prompt already tells the agent where files are and which languages are available. Benchmark task prompts should contain only task-specific context (service names, specific paths not inferrable from the environment, output format constraints). If a language or path reference needs to appear in a skill body or role body, call `_buildLangsDesc()` / `_buildWorkspaceDesc()` and splice the result in — do not write a fixed string.

## Common operations

**Add a tool:**
1. Add spec to `TOOLS_SPEC` in `tool-schemas.ts`; add name to `ALL_TOOL_NAMES` in `config.ts`
   and to `AGENT_TOOL_NAMES` in `step-validator.ts` (pseudo-call detection)
2. Add handler in `executeToolAsync()` (`tools.ts`); add label in `toolLabel()`
3. Add mention in `buildSystemPrompt()` (`system-prompt.ts`)
4. If result can be large: add truncation case in `truncateResultForHistory()`

**Add a setting:**
1. Add getter in `config.ts` (`function getFoo() { return ls('fg_foo', 'default'); }`)
2. Add HTML control in `index.html`; add population in `settings-ui.ts`
3. Non-credential settings: add to `PROFILE_KEYS` + `PROFILE_KEY_META` in `profiles.ts`

**Add a background LLM call:**
1. Call `callLLMComplete(prompt, { ..., label: 'worker:role:role' }, handle)` — never raw fetch
2. Pick a label that matches an existing pattern in `_friendlyLabel`, or add one
3. If calling from within `executeWorkers`, pass the existing outer handle rather than creating a sub-step
