// skills.js — FreeGent: skills loading, rendering, toggle, install, create form, autocomplete
// Depends on: config.js, workspace.js

const TOOL_LABELS = {
    list_files:                'List Files (list_files)',
    read_file:                 'Read File (read_file)',
    write_file:                'Write File (write_file)',
    undo_write:                'Undo Write (undo_write)',
    replace_in_file:           'Replace in File (replace_in_file)',
    apply_patch:               'Apply Patch (apply_patch)',
    delete_file:               'Delete File (delete_file)',
    append_file:               'Append to File (append_file)',
    update_task_status:        'Update Task Status (update_task_status)',

    web_search:                'Web Search (web_search)',
    deep_research:             'Deep Research (deep_research)',
    academic_search:           'Academic Search (academic_search)',
    package_search:            'Package Search (package_search)',
    fetch_url:                 'Fetch URL (fetch_url)',
    execute_code:              'Execute Code (execute_code)',
    run_workers:               'Run Workers (run_workers)',
    repo_map:                  'Repo Map (repo_map)',
    search_workspace:          'Grep Workspace (search_workspace)',
    context7_docs:             'Context7 Docs (context7_docs)',
    run_git:                   'Run Git (run_git)',
    ast_query:                 'AST Query (ast_query)',
    generate_image:            'Generate Image (generate_image)',
};
const TOOL_DESCRIPTIONS = {
    list_files:                'List all files in workspace',
    read_file:                 'Read file contents',
    write_file:                'Create or overwrite a file',
    undo_write:                'Revert the last write to a file (session only)',
    replace_in_file:           'Replace exact text in a file (targeted edit)',
    apply_patch:               'Apply a unified diff patch to a file',
    delete_file:               'Delete a workspace file',
    append_file:               'Append text to a file',
    update_task_status:        'Update task status and optionally log a note',

    web_search:                'Search the internet; source param selects engine (web/wikipedia/hackernews/github/stackoverflow/reddit/devto/gdelt/duckduckgo)',
    deep_research:             'Multi-round research: plan, search, read sources, synthesize a cited report',
    academic_search:           'Search academic papers; source param selects database (arxiv/semantic_scholar/crossref/pubmed)',
    package_search:            'Search package registries; registry param selects npm or pypi',
    fetch_url:                 'Fetch a web page or JSON API as text',
    execute_code:              'Execute Python, Bash, or JavaScript code in a sandbox',
    run_workers:               'Run multiple parallel worker agents',
    repo_map:                  'Get a compact symbol map of all workspace code files',
    search_workspace:          'Search all workspace files for a literal string or regex',
    context7_docs:             'Look up library docs from Context7',
    run_git:                   'Run git commands in the workspace',
    ast_query:                 'Query code structure with tree-sitter AST patterns',
    generate_image:            'Generate an image via Hugging Face Inference API',
};


const BUILTIN_SKILLS = [
    {
        name: 'debug',
        description: 'Systematically diagnose an error — trace to root cause, apply minimal fix, verify.',
        trigger_on_tool: 'execute_code=>exit_code!=0&&stdout==',
        trigger_on_completion: 'triggered',

        body: `A command or test just failed. Diagnose it before changing anything:

### Step 1 — Gather context
Parse the error: type, file, line number, stack trace. Call list_files to orient yourself. Read the file(s) named in the stack trace, plus any direct dependencies or config files that affect the failure path.

### Step 2 — State the root cause hypothesis
Before touching any code: write one sentence — "This fails because X when Y." If uncertain, list 2–3 hypotheses ranked by likelihood and mark which you'll investigate first.

### Step 3 — Trace to root cause
Follow the call chain backward from the error site. Common culprits: off-by-one, null/undefined not handled, wrong type, missing await, stale closure, mutation of shared state. Fix the root cause, not the symptom.

### Step 4 — Apply a minimal fix
Read the file before editing. Change only what is necessary. If the fix is non-obvious, add a one-line comment explaining WHY (not what).

### Step 5 — Verify
If execute_code is available, reproduce the original error first, then confirm the fix resolves it. If not, describe the condition under which the fix is correct and what would need to be tested manually.`
    },
    {
        name: 'test',
        description: 'Generate tests for existing code, matched to the project\'s framework and conventions.',
        trigger_on_filetype: '.test.js, .spec.js, .test.ts, .spec.ts, .test.py, _test.py, _test.go',
        body: `When writing or extending tests for a file or function:

### Step 1 — Read the target and existing tests
Read the file to test. Look for an existing test file (same name with .test/.spec suffix, or under tests//__tests__) — if found, read it and match its style exactly.

### Step 2 — Detect the test framework
Check package.json / pyproject.toml for: Jest, Vitest, Mocha, pytest, unittest. If none configured: default to Vitest for JS/TS, pytest for Python.

### Step 3 — Write tests
For each public function or class method:
- **Happy path**: normal input → expected output
- **Edge cases**: empty input, boundary values, null/undefined, empty collections, max values
- **Error paths**: invalid input, exceptions that should be thrown

Name tests descriptively: \`it('returns null when input is empty')\` / \`def test_parse_returns_none_on_empty_string\`.
Test the public contract, not internal implementation details.

### Step 4 — Write the file
Save to the conventional location for the detected framework. If execute_code is available, run the tests and fix any failures before reporting.

Report: how many tests written, what cases are covered, anything that would need mocking infrastructure not available in the workspace.`
    },
    {
        name: 'search',
        requires_tools: 'run_workers',
        // Excluded for the 'agent' role because agent workers have no run_workers access —
        // spawning a sub-worker from an already-spawned worker is disallowed by the role ceiling.
        exclude_roles: 'agent',
        description: 'Delegate code location to a disposable-context search worker instead of grepping and reading in the main loop.',
        // Reactive only. A keyword trigger would overlap code-first's, and the guidance is
        // worth its tokens exactly when the main loop is already grinding through files —
        // which is what these repeat counts detect.
        trigger_on_repeat: 'search_workspace x4, read_file x6',
        body: `You are locating code by grepping and reading files in the main loop. That burns
your context on material you will not need again. Delegate the search instead.

Spawn one worker via \`run_workers\` with the following task (fill in the bracketed parts):

\`\`\`
Find all code and files relevant to this task: [task description]

You are a search worker. Your context window is disposable — read as many files and run as many searches as you need. Only your final report reaches the main agent.

Search strategy:
1. Run \`list_files\` and \`repo_map\` in parallel to orient. Note file names and all exported symbols.
2. Extract 3–6 keywords or symbol names from the task. Run \`search_workspace\` calls in parallel for each.
3. For every file with hits: read the full file or the relevant section (use offset+limit for large files). Do not skip files to save tokens — you have plenty.
4. If grep returns nothing or truncated results: try broader patterns, partial names, related terms, or read the most likely files directly based on repo_map output.
5. Repeat up to 3 rounds, narrowing in. Stop when you have found the relevant code or confirmed it does not exist.

Return this exact format:

## Found

**path/to/file.js:42–67** — [one sentence: what this code does and why it is relevant to the task]
\`\`\`
[exact code excerpt — trim to what matters, keep enough context to understand it]
\`\`\`

(repeat for each relevant location)

## Not found
[List anything specifically searched for that was not found, so the main agent does not search again.]
\`\`\`

After the worker returns, use its findings to proceed with the task. Do not follow up with read_file or search_workspace in the main loop for the same files.`
    },
    {
        name: 'task-setup',
        description: 'Initialize a new task: task file creation, kanban rules.',
        exclude_mode: 'container',
        trigger_on_file_present: 'fg-tasks/',
        body: `**Direct task path** (first message is a concrete request): THAT is your task. Missing fg-tasks/ledger.md is not a blocker. Before your first code edit, write the task to fg-tasks/current.md:
1. write_file("fg-tasks/current.md", ...) — verbatim request, concrete acceptance criteria, empty ## Attempts section
2. Work: read, edit, verify
3. After each edit attempt, append_file under ## Attempts: what changed (file:line), whether resolved

**Autonomous path** (first message points at ledger): read fg-tasks/ledger.md. Pick highest-priority open task (High > Medium > Low; lowest ID first).

### Kanban rules
open → **in-progress** → **in-review** → **done**
- update_task_status(path, status) updates both the task file and ledger — do NOT also call replace_in_file.
- Failure reason must specify: file, line, what was changed, why it did not resolve.
- List_files only when task filenames are unknown.
- Ledger shows open but task file says done → ledger is stale. Sync with update_task_status and investigate.`
    },
    {
        name: 'execution-workflow',
        description: 'Plan→Execute→Verify pattern for mid-task work, and completion format.',
        exclude_mode: 'container',
        trigger_on_file_present: 'fg-tasks/',
        body: `### Plan
Read task file. If ## Execution Plan absent/incomplete and the task is non-trivial (multiple files, unclear scope, or parallel steps), write the plan yourself inline before proceeding. For simple single-file tasks write the plan inline too. After planning, note the plan summary.

### Execute
Set in-progress. For each step:
- **Simple** (one file, one edit, completable in one pass): read_file + replace_in_file directly — do not spawn.
- **Parallel** (independent subtasks with no shared state): batch into one run_workers call.
- **Long-horizon** (many sequential steps, or deep search that would exhaust main-loop context): spawn a worker with a specific scoped target.

### Verify
Read changed files to confirm expected lines present. Code-based: read the file, confirm the change is present. If correct, mark done — do not wait for runtime confirmation.

### Failure recovery
- Direct edit fails (old_string not found): re-read the file, copy exact text, retry once. If still fails, rewrite function with write_file.
- Worker stalls: re-read changed file yourself. If fix is present, verification passed.
- Worker stalls after 2 retries: spawn replanning via run_workers([{id:"replan", task:"Plan in <task-path> failed at step N. Revise ## Execution Plan.", role:"director"}]). Max 2 replan attempts → update_task_status(path, "failed", <reason>).

### Re-entering a failed task
Read task file for prior attempt notes. If a prior log entry names the exact change (file + line), read that file to confirm whether it is present. Do not re-investigate what is already recorded.

### Completion message
\`\`\`
### Task NNN complete — <title>
**Goal:** One sentence.
**Approach:** 2–3 sentences on what was done and why.
**Changes:** list of file — what changed
**Outcome:** One sentence on what the user can now observe.
\`\`\`
End with COMPLETED. If BLOCKED instead: BLOCKED: <exact blocker — what is missing, what was attempted>`
    },
    {
        name: 'deep-research',
        description: 'Guidance for multi-source research: call deep_research ONCE; web_search is for quick facts only.',
        requires_tools: 'deep_research',
        exclude_mode: 'container',
        trigger: 'research, deep dive, find information about',
        body: `Call deep_research ONCE with the question. It plans, searches, reads, and synthesizes a cited report. Do NOT chain web_search calls for deep questions — web_search is for single quick facts only.

deep_research takes a "query" string (the research question) and returns a structured report with citations. Use it for "research X", "deep dive on Y", or any question needing multiple web sources.`
    },
    {
        name: 'failure-recovery',
        description: 'Tool failure recovery tactics: corrected args, re-read exact text, smaller steps, worker replanning, loop detection.',
        trigger_on_failure: 'replace_miss x2, tool_error x2, http_error x1',
        trigger_on_repeat: 'read_file x8, execute_code x10, replace_in_file x5, write_file x3',
        body: `**replace_in_file fails** (old_string not found): re-read the file first (read_file), copy the exact current text around the target, then retry. If still fails, rewrite the function with write_file instead.

**execute_code fails**: narrow the step — test one line at a time, print intermediate values. If a command times out, add a shorter timeout or break into smaller steps.

**Same tool repeated** (read_file, execute_code, replace_in_file, write_file used many times without progress): you may be in a loop. Stop repeating the same approach. Re-read the task, check what information you already have, and try a fundamentally different tactic. If stuck, delegate to a worker for a fresh perspective via run_workers([{id:"fresh-perspective", task:"<current task and what was tried>", role:"director"}]).

**Worker stalls**: re-read the changed file yourself with read_file. If the fix is present, treat verification as passed. If still failing after 2 stalls, spawn replanning:
run_workers([{id:"replan", task:"Plan in <task-path> failed at step N because <reason>. Revise ## Execution Plan.", role:"director"}])
Max 2 replan attempts. If still failing → update_task_status(path, "failed", "<reason>").

**General**: The core's after-fail rule applies — a failed tool is not a stopping condition. If you cannot proceed, state BLOCKED with the exact blocker.`
    },
];

// Built-in rules — standing context injected when triggered, not invoked procedurally.
// Rules with a body_fn field compute their body dynamically at injection time (see buildTriggeredGuidance).
// Analogous to .cursor/rules or .claude/rules in other tools.
const BUILTIN_RULES = [
    {
        name: 'datetime',
        type: 'rule',
        description: 'Injects current date and time when the user asks about time-sensitive information.',
        exclude_mode: 'container',  // benchmarks already get date via system prompt; time-of-day is irrelevant
        // Narrow set: only phrases that genuinely require knowing the current time.
        // Broad words (when, date, year, week, month, age, duration, calendar) were removed
        // because they fire on unrelated queries ("date format", "what year was X invented?")
        // and bust the shared prefix cache with a per-minute timestamp for no benefit.
        trigger: 'what time, current time, right now, at the moment, local time, what day, what date, today, tonight, yesterday, tomorrow, this morning, this afternoon, this evening, hour, minute, o\'clock, timezone, utc, gmt, time zone, schedule, deadline, how long ago, how soon, time elapsed, time remaining, timestamp',
        body: '',
        body_fn: () => {
            const n = new Date();
            const pad = x => String(x).padStart(2, '0');
            const tz = n.toTimeString().match(/GMT[+-]\d{4}/)?.[0] ?? '';
            return `Current date and time: ${n.toISOString().slice(0, 10)} ${pad(n.getHours())}:${pad(n.getMinutes())} local (${tz})`;
        },
    },
    {
        name: 'location',
        type: 'rule',
        description: 'Injects approximate user location (timezone + locale) when the user asks about location-sensitive information.',
        exclude_mode: 'container',  // location context is only meaningful in interactive (WebUI/TUI) sessions
        trigger: 'near me, nearby, local, my location, my city, my country, my region, my area, where am i, my timezone, my language, my locale, in my country, in my city, around me, closest, nearest, weather, forecast, temperature outside, humidity, wind, rain, snow, sunny, cloudy, restaurant, shop, store, cafe, hotel, hospital, pharmacy, airport, train station, bus stop, directions, navigate, map, open now, delivery',
        body: '',
        body_fn: () => {
            const tz   = Intl.DateTimeFormat().resolvedOptions().timeZone ?? '';
            const lang = typeof navigator !== 'undefined' ? (navigator.language ?? '') : '';
            const geo  = typeof getGeoCache === 'function' ? getGeoCache() : null;
            const parts: string[] = [];
            if (geo?.city)     parts.push(`city: ${geo.city}`);
            if (geo?.region)   parts.push(`region: ${geo.region}`);
            if (geo?.country)  parts.push(`country: ${geo.country}`);
            parts.push(`timezone: ${(geo?.timezone || tz) || '(unknown)'}`);
            if (lang)          parts.push(`locale: ${lang}`);
            if (geo?.org)      parts.push(`ISP/org: ${geo.org}`);
            return `User approximate location — ${parts.join('; ')}`;
        },
    },
    {
        name: 'image',
        type: 'rule',
        description: 'Image rendering and generation rules — how to display SVG, charts, and AI-generated images inline.',
        trigger: 'generate image, create image, draw, illustrate, visualize, make a picture, a photo of, an image of, generate a picture, paint, artwork, render an image, image generation, text to image, stable diffusion, flux, svg, chart, diagram, plot, visualization, graph, matplotlib, seaborn, plotly, histogram, scatter, bar chart, pie chart, heatmap, logo, icon, infographic',
        trigger_on_tool: 'execute_code=>[IMAGE:, generate_image',
        trigger_on_filetype: '.svg, .png, .jpg, .jpeg, .gif, .webp, .bmp, .ico, .avif',
        trigger_on_media: 'image',
        body: `## Image Generation & Visual Output

### Displaying images inline
The chat renders visual output directly. Three paths depending on the task:

**Data visualization (charts, plots, graphs)** — use \`execute_code\` with matplotlib, seaborn, or plotly. Any image file your Python code writes (e.g. \`plt.savefig("chart.png")\`, \`fig.write_image("chart.svg")\`) is **automatically displayed inline** in the tool output — no extra encoding needed. After the code runs, the tool result contains \`[IMAGE:filename]\` in stdout — copy that exact marker into your chat reply to embed it (e.g. write \`[IMAGE:chart.png]\`). **Never write \`![alt](filename)\`** — a bare workspace filename is not a URL and will show as a broken image. **Never \`print("[IMAGE:filename]")\` from inside the Python code** — the marker is added automatically by the tool infrastructure; printing it yourself results in a broken image because the image won't be in the display store.

**SVG diagrams / illustrations** — generate SVG code and paste the raw \`<svg>...</svg>\` XML directly in your reply. The chat renders it inline. Do NOT base64-encode SVGs — write the XML directly.

**AI-generated raster images (photos, artwork)** — call \`generate_image\`, then embed the result with \`[IMAGE:key]\` where key is from the tool's \`display\` field.

**Never** compute or fabricate base64 image data — only use \`[IMAGE:key]\` markers with keys from tool results or files your code actually wrote.

### Tool: generate_image (requires HuggingFace token in Settings)

\`\`\`
generate_image({
  prompt: "a photorealistic sunset over snow-capped mountains, golden hour, dramatic clouds",
  filename: "sunset.png",              // optional — saved to workspace
  negative_prompt: "blurry, low quality, watermark"  // optional, SDXL only
})
\`\`\`

Tries **stabilityai/stable-diffusion-xl-base-1.0** first, falls back to **black-forest-labs/FLUX.1-schnell**. Returns \`{ success, path, model, prompt, display }\`.

### Prompting tips
- Be specific: subject, style, lighting, mood, medium ("oil painting", "photorealistic", "watercolor", "pixel art")
- For SDXL use \`negative_prompt\` to exclude: "blurry, low quality, watermark, text, deformed"
- FLUX.1-schnell handles natural-language prompts well; SDXL benefits from comma-separated style tags

### Workflow
1. **Diagram/SVG request:** generate SVG code, paste raw \`<svg>...</svg>\` XML in your reply
2. **Photo/realistic image request:** call \`generate_image\`, then write \`[IMAGE:key]\` in your reply
3. If the HuggingFace token is missing, tell the user to add it in **Settings → HuggingFace Token**
4. HF free tier may be slow on first call (cold start ~20–60s) or return 503 — retry once on failure`
    },
    {
        name: 'audio',
        type: 'rule',
        description: 'Audio file processing — how to handle attached audio depending on provider capability.',
        trigger_on_media: 'audio',
        body: `## Audio Input

An audio file has been attached to this message.

**If you can directly perceive the audio** (Gemini, NVIDIA Omni, or other audio-capable model):
- Transcribe speech content if asked, or if no specific task is given
- Note language, number of speakers, tone, and any background sounds
- For music or sound effects: describe tempo, genre, instruments, mood, or what the sound resembles
- Be specific about what you hear

**If you cannot perceive the audio** (text-only provider):
- Acknowledge the file: name, format, size
- Do NOT guess or fabricate what the audio contains
- Suggest the user switch to Gemini or another audio-capable model for direct analysis
- If Whisper or a speech-to-text tool is available, offer to transcribe via \`execute_code\`

Be explicit about what you can and cannot perceive from the file.`
    },
    {
        name: 'pdf',
        type: 'rule',
        description: 'PDF document processing — how to handle attached PDFs depending on provider capability.',
        trigger_on_media: 'pdf',
        body: `## PDF Input

A PDF document has been attached to this message.

**Gemini (current provider):** The PDF is sent as inline data — you can read its full text, tables, and structure directly.
- Read and summarise, answer questions, or extract data as requested
- For long documents: start with an executive summary unless the user asks otherwise
- Preserve table structure as markdown tables where useful

**Other providers:** PDF is not processed natively — it appears as a text note only.
- Acknowledge the file: filename and size
- Suggest the user switch to Gemini for direct PDF reading
- Or offer to extract text via execute_code: \`execute_code(language="bash", code="pip3 install pdfplumber")\` then \`execute_code(language="python", code="import pdfplumber; pdf = pdfplumber.open('filename.pdf'); print('\\\\n'.join(p.extract_text() for p in pdf.pages))")\`
  (requires the file to be in the workspace — ask the user to upload it there first if needed)

Be explicit about what you can and cannot read from the file.`
    },
    {
        name: 'sql',
        type: 'rule',
        description: 'SQL and database guidance — schema inspection, value quoting, and identifier accuracy.',
        trigger: 'sql, mysql, sqlite, postgresql, postgres, database, insert, create table, group by, order by',
        body: `## SQL / Database

**Schema first.** Before writing any INSERT, UPDATE, or SELECT: run \`DESCRIBE table_name\` (MySQL) or \`PRAGMA table_info(table_name)\` (SQLite) to get exact column names and types. Never guess column names from prose — the actual name may include spaces, parentheses, or units (e.g. \`Tonnage (GRT)\`).

**Quoting by column type:**
- \`text\`, \`varchar\`, \`char\` → always single-quote: \`'value'\`
- \`int\`, \`bigint\`, \`decimal\`, \`float\` → numeric literal: \`42\`, not \`'42'\`
- Dates → quote as strings: \`'2024-01-15'\`

**Identifiers.** Always backtick-quote ALL table and column names in INSERT and UPDATE statements — every column, even simple single-word names like \`\\\`Character\\\`\`, \`\\\`Team\\\`\`, \`\\\`Score\\\`\`. In SELECT and WHERE, backtick names that contain spaces, parentheses, or reserved words: \`\\\`Tonnage (GRT)\\\`\`.

**Value accuracy.** Copy values from the source data exactly — preserve formatting characters (commas in numbers, \`%\` suffixes, unit strings) if that is how the source stores them. Do NOT use \`CAST\` in SELECT output when a formatted string is stored: \`CAST('32,502' AS UNSIGNED)\` returns \`32\`, not \`32,502\`. Only CAST for sorting/comparison, never to produce the final answer.

**Date format.** Copy date and time strings exactly as written in the source (task description or existing rows) — do not reformat to ISO 8601 or any other standard. If the task says "August 11, 2021", use \`'August 11, 2021'\` in VALUES/WHERE, not \`'2021-08-11'\`. Inspect existing rows to confirm format when unclear.

**INSERT vs UPDATE.** Choose by the task's verb, not by row existence. "Record", "add", "was recorded", "the data includes" → INSERT. "Update", "change", "set X to Y" → UPDATE. Use SELECT only to learn the stored value format, not to decide which statement to use.

**Aggregation.** "Total number of X" or "how many" → \`COUNT(*)\`, not \`SUM\`. "Total / sum of X" → \`SUM(column)\`. Never swap these.

**Numeric-stored-as-text.** When ordering or comparing a column that stores numbers as text, cast it: \`ORDER BY CAST(column AS DECIMAL)\`, not \`ORDER BY column\` (text sort gives wrong order: '13' < '5').

**MySQL via bash.** Always use single quotes for the \`-e\` argument — backtick identifiers inside double quotes trigger shell command substitution and produce empty output:
- Correct: \`mysql -u root db -e 'SELECT \\\`Column\\\` FROM \\\`table\\\`'\`
- Wrong: \`mysql -u root db -e "SELECT \\\`Column\\\` FROM \\\`table\\\`"\` ← bash runs \`Column\` as a command`
    },
    {
        name: 'code-first',
        type: 'rule',
        exclude_roles: 'director',
        description: 'File navigation, code-search strategy, and workspace orientation.',
        trigger: 'search, look at, what does, how does, where is, list files, codebase, workspace, source code, repository',
        trigger_on_filetype: '.js, .py, .ts, .go, .rs, .java, .cpp, .c, .rb, .php, .cs, .swift, .kt, .vue, .jsx, .tsx',
        trigger_on_turn: 'first',
        body: `## Working in the codebase
0. **Code-first.** When a question is about what this project does, has, or lacks — read workspace files before consulting external sources. Verify with search_workspace or read_file first. External research anchors wrong assumptions.
1. **Orient once.** Use **repo_map** for code tasks (file structure + symbols), or **list_files** for doc/data tasks. Never call either again if already in context. **"local/foo" and "foo" are the same file — never read twice.**
2. **File search hard stops:**
   - NEVER use execute_code to list or search. Use list_files or search_workspace — faster, no sandbox startup.
   - NEVER grep or read files sequentially. "The grep was truncated, let me read the file" — forbidden.
   - NEVER re-read a file already in context.
   - In a new session: treat all files as unknown. Start with \`repo_map\` or \`search_workspace\` — never open a file speculatively without a grep hit.
   - NEVER read a whole file to find a function. Use line-range read_file or search_workspace.
   - CORRECT PATTERN: \`run_workers\` with one worker — (1) repo_map + search_workspace in parallel, (2) read freely, (3) return excerpts with file:line. One call; nothing else.
3. **Before writing a new file:** read one similar existing file first and match it — import style, naming, error handling, type-annotation depth. Do not invent a house style.
4. **Write complete code.** No pseudocode and no \`TODO: implement\` stubs. If the real logic is not yet known, write a stub that returns a typed placeholder and say so — never leave a comment where code belongs.
For code execution, deletions, or multi-file refactors use a **coder** worker.`
    },
    {
        name: 'debug-strategy',
        type: 'rule',
        description: 'Stack trace and error debugging — how to trace to root cause efficiently.',
        trigger: 'error, exception, traceback, TypeError, AttributeError, NameError, SyntaxError, undefined is not, is not defined, failed, bug, broken, crash, wrong output, unexpected result',
        trigger_on_message_pattern: 'Traceback|TypeError|AttributeError|NameError|SyntaxError|ReferenceError|at line \\d|\\bError:|Exception:|FAILED\\b|stack trace|\\bat \\w',
        trigger_on_failure: 'tool_error',
        body: `**Debugging errors / stack traces:** Immediately call **search_workspace** for ALL function names and identifiers in the trace (in parallel). Never start with list_files. Use line-range **read_file** with exact line numbers from the trace — never read a whole file to find an error. If errors reference about:srcdoc line numbers that don't match any standalone JS file, check the HTML file that embeds the script.`
    },
    {
        name: 'write-verify',
        type: 'rule',
        exclude_roles: 'director',
        description: 'Verify file writes and worker output immediately after any write.',
        trigger_on_tool: 'write_file, replace_in_file, apply_patch',
        body: `**After any file write:** immediately verify with the fastest available check — execute_code syntax/compile check for Python and typed languages. Do NOT re-write the file as verification — \`{success: true}\` means the content was written; trust it. Never re-write unless you have read the file back and found it incorrect. A worker reporting \`"wrote": ["file.py"]\` is not a correctness guarantee.

**run_workers with blocked workers:** if the result contains \`"incomplete"\` files or a \`"warning"\` field, read back every file in \`"incomplete"\` and verify before proceeding. Never declare success when any worker blocked.

**Python — verify before reporting:** Before telling the user about a suspected Python syntax error, confirm with py_compile. If it compiles clean it is NOT a bug.`
    },
    {
        name: 'code-fix-done',
        type: 'rule',
        description: 'Definition of done for code fixes — stop when the fix is verified, not later.',
        trigger: 'failing, assert, reproduce, regression, pytest, unittest, jest, mocha, test suite, test case, test file, test script',
        trigger_on_tool: 'replace_in_file=>success==true, apply_patch=>success==true, write_file=>success==true',
        trigger_on_completion: 'triggered',
        body: `**Code fix definition of done:** If an edit was needed: (1) confirm it is applied — \`execute_code(language="bash", code="git diff HEAD --stat")\` must show a non-empty diff, (2) your reproduction or targeted check passes, (3) the nearest existing tests pass. If the investigation concluded no change was required, state that explicitly and output COMPLETED. Do not continue exploring once all affected locations are verified fixed, or a no-change conclusion is confirmed — that is budget waste, not diligence. Re-check the original task statement before finishing — your own test cases are not the spec.

**If the package cannot be imported** (missing build artifacts, uncompiled C extensions, missing optional dependencies): (1) try importing only the specific changed module(s) directly — \`import sys; sys.path.insert(0, '/workspace'); from package.module import TargetClass\` — and test that; (2) if even that fails after one attempt, declare \`BLOCKED: <import error>\` — do not try to rebuild the package, patch build guards, or install missing dependencies; (3) never run tests against an installed package as a substitute for verifying the workspace source — installed versions may have different APIs and do not test your patch.`
    },
    {
        name: 'ops-verify',
        type: 'rule',
        description: 'Verify the effect of system/configuration changes by reading state back.',
        trigger: 'permission, chmod, chown, install, uninstall, configure, systemctl, service, daemon, cron, environment variable, user account, useradd, mount, firewall, symlink, alias',
        trigger_on_completion: 'triggered',
        body: `**System/configuration changes:** verify the effect with a command that reads the state back (ls -l, id, stat, getent, service status, env, readlink) — the exit status of the command that made the change is not verification. Before COMPLETED, re-read the original task and confirm each explicitly stated requirement is satisfied, including negative ones (e.g. "but NOT user X").`
    },
    {
        name: 'artifact-check',
        type: 'rule',
        description: 'Verify task-specified output files exist before declaring completion.',
        trigger: 'save to, write to, output file, submission, save the, export to, save results, output to, create a file, generate a file, save as',
        trigger_on_completion: 'triggered',
        body: `**The task names an output artifact** (a file to save, write, or submit). Before COMPLETED: verify the artifact exists at the exact required path with plausible content — list_files or read it back. A findings summary in chat is NOT the deliverable; the file is.`
    },
    {
        name: 'analysis-output',
        type: 'rule',
        description: 'For data analysis tasks: require actual results in the final response, not just "analysis complete".',
        trigger: 'analyze, analysis, data, dataset, csv, result, score, accuracy, compute, calculate, model, train, fit, evaluate, metric, compare, correlation, cluster, classify, plot, figure, chart, prediction, forecast',
        trigger_on_completion: 'triggered',
        body: `**Include key results in your final response.** Before COMPLETED: state the actual outcome — numbers, rankings, key findings, or a summary table. Writing results to a file is fine; also state the main values inline (e.g. "Best accuracy: 87.3%"). Do not end with just "analysis complete" or a bare COMPLETED without results.`
    },
    {
        name: 'blocked-verify',
        type: 'rule',
        description: 'Before declaring BLOCKED because a value cannot be found, retry with normalized formats.',
        trigger_on_completion: 'blocked',
        body: `**Before declaring BLOCKED because a value, row, or file cannot be found:** re-check with normalized and alternative forms — dates in multiple orderings ("August 15, 2000" / "15 August 2000" / "2000-08-15"), case-insensitive comparison, trimmed whitespace, partial/LIKE matching, singular/plural variants. Only declare BLOCKED after at least one normalized re-check has also failed; state which forms you tried.`
    },
    {
        name: 'verify-with-tests',
        type: 'rule',
        description: 'After editing code, use the project\'s own test suite to verify changes (pytest, unittest, npm test, etc.) when tests exist for the affected files.',
        trigger_on_file_present: 'tests/, test/, spec/, __tests__/',
        trigger_on_completion: 'triggered',
        requires_tools: 'execute_code',
        body: `## Verify before declaring complete

A test suite is present. Before COMPLETED:

1. **Run the full test file** for any file you edited — \`python -m pytest tests/test_foo.py\`, \`npm test\`, etc. Never use \`-k\` to exclude tests: filters hide regressions the evaluator will catch. A passing run across the full file is required. Code review, diff inspection, and "the logic looks correct" are not substitutes.
2. **If the environment blocks execution after one genuine attempt** (no compiler, pytest not installed, C extension import fails, missing system library): declare \`BLOCKED: <specific reason>\` — e.g. \`BLOCKED: C extensions require gcc which is not installed\`. One attempt is enough to confirm the environment limit; do not try to rebuild, patch build systems, or install missing dependencies.`,
    },
    {
        name: 'task-continuity',
        type: 'rule',
        exclude_roles: 'director',
        description: 'Task ledger: read before starting, append when done, use update_task_status.',
        trigger_on_file_present: 'fg-tasks/',
        trigger_on_event: 'task-start',
        trigger: 'ledger, kanban, in-progress, backlog',
        body: `## Task Ledger
Task files live in \`fg-tasks/NNN-slug.md\`; \`fg-tasks/ledger.md\` indexes them by ID, status, and title. Use \`update_task_status\` to change status — the ledger updates automatically. Call it as your **first action** when starting any task, and **last action** when finishing.

**Task continuity:** read \`fg-tasks/ledger.md\` before any tool calls — it records what has already been confirmed done. After confirming a fix works, append a one-line entry: \`DONE [timestamp]: description\`. This prevents re-investigating already-resolved bugs.`
    },
    {
        name: 'workers',
        type: 'rule',
        description: 'Worker orchestration rules, roles, and delegation strategy.',
        trigger: 'worker, parallel, delegate, researcher, coder, in parallel, multiple tasks, run_workers',
        trigger_on_history_tool: 'run_workers',
        body_fn: () => {
            const webTools = [enabledTools.has('web_search') ? 'web_search' : '', enabledTools.has('fetch_url') ? 'fetch_url' : ''].filter(Boolean);
            const researcherTools = ['read_file', 'repo_map', 'search_workspace', ...(webTools.length ? ['web/academic search'] : [])].join(', ');
            return `## Workers

**Spawn a worker when the subtask meets one or more of these:**
- **Parallelizable** — independent pieces that don't need each other's output; batch them into one \`run_workers\` call
- **Long-horizon** — many sequential steps that would exhaust main-loop context or attention
- **Isolated context** — benefits from a clean window, free from accumulated history (e.g. summarising a large document)
- **Specialisation** — needs a distinct role or tool set (researcher, coder)
- **Fault isolation** — failure must not corrupt parent state; validate result before merging

**Do not spawn** for single-step actions, simple lookups, tasks needing tight back-and-forth with parent state, or when coordination overhead exceeds the benefit.

**Default rule:** if you can complete it in one focused pass without losing track of state, do it yourself.

**Operational rules:**
1. **One step = one \`run_workers\` call** — all independent pieces in a single call, never sequential.
2. **Workers need a specific target** — never broad sweeps; never spawn a worker just to list files.
3. **Blocked worker → act directly** — don't spawn a follow-up for the same subtask.

**Worker roles and their tools** (set the \`role\` field):
- **researcher** — read_file, repo_map, search_workspace${webTools.length ? ', ' + webTools.join(', ') + ', academic_search, package_search, context7_docs' : ''}
- **coder** — read_file, write_file, replace_in_file, apply_patch, execute_code, search_workspace, repo_map, run_workers
- **director** — autonomous orchestrator: reads ledger, delegates to coder/researcher workers, drives tasks end-to-end
Omit \`role\` for a general-purpose worker (gets read_file, repo_map, search_workspace + write tools).`;
        },
        body: '',
    },
    {
        name: 'api-calls',
        type: 'rule',
        description: 'fetch_url usage examples for common APIs: GitHub, Linear, Slack, Notion, GraphQL.',
        trigger: 'github, gitlab, linear, slack, notion, graphql, webhook, stripe, jira, confluence, discord, rest api, http post, http put, api request, oauth, bearer token, api.github',
        requires_tools: 'fetch_url',
        body: `## API call examples (fetch_url)
\`\`\`js
// GitHub — create issue
fetch_url({ url: "https://api.github.com/repos/owner/repo/issues", method: "POST",
  headers: { "Authorization": "Bearer ghp_TOKEN", "X-GitHub-Api-Version": "2022-11-28" },
  body: { "title": "Bug", "body": "Steps...", "labels": ["bug"] } })

// GitHub GraphQL
fetch_url({ url: "https://api.github.com/graphql", method: "POST",
  headers: { "Authorization": "Bearer ghp_TOKEN" },
  body: { "query": "{ repository(owner:\\"org\\", name:\\"repo\\") { issues(first:10) { nodes { title } } } }" } })

// Linear — create issue
fetch_url({ url: "https://api.linear.app/graphql", method: "POST",
  headers: { "Authorization": "lin_api_TOKEN" },
  body: { "query": "mutation { issueCreate(input: { teamId:\\"ID\\", title:\\"Fix\\" }) { success } }" } })

// Slack webhook
fetch_url({ url: "https://hooks.slack.com/services/T.../B.../...", method: "POST",
  body: { "text": "message", "blocks": [...] } })

// Notion — append block
fetch_url({ url: "https://api.notion.com/v1/blocks/PAGE_ID/children", method: "PATCH",
  headers: { "Authorization": "Bearer secret_TOKEN", "Notion-Version": "2022-06-28" },
  body: { "children": [{ "object":"block","type":"paragraph","paragraph":{"rich_text":[{"text":{"content":"note"}}]} }] } })
\`\`\``
    },
    {
        name: 'html-cors-proxy',
        type: 'rule',
        description: 'Use the FG proxy for external data fetches in agent-written HTML files.',
        trigger: 'html fetch, html data, cors, html api, html app',
        trigger_on_tool: 'write_file=>.html',
        body: '',
        body_fn: () => {
            if (typeof window === 'undefined') return '';
            const _px = typeof getEffectiveProxy === 'function' ? getEffectiveProxy() : '';
            if (!_px) return '';
            return `## External data fetches in HTML files

HTML pages you write run on the FreeGent origin and cannot fetch external URLs directly — CORS blocks them. **Always route external data requests through the FG proxy:**

\`\`\`js
const PROXY = '${_px}';
// Basic usage
const resp = await fetch(PROXY + '?url=' + encodeURIComponent('https://api.example.com/data'));

// With extra request headers (base64-encoded JSON, safe subset only: Accept, Referer, etc.)
const h = btoa(JSON.stringify({ 'Accept': 'application/json', 'Referer': 'https://api.example.com/' }));
const resp2 = await fetch(PROXY + '?url=' + encodeURIComponent(targetUrl) + '&h=' + h);
\`\`\`

**Rules:**
- **Never** hardcode third-party CORS proxies (corsproxy.io, allorigins.win, cors.eu.org, cors-anywhere, codetabs, etc.) — they are unreliable and block finance/data APIs.
- For stock/finance CSV data, prefer **Stooq**: \`https://stooq.com/q/d/l/?s=TICKER.us&d1=YYYYMMDD&d2=YYYYMMDD&i=d\` — returns \`Date,Open,High,Low,Close,Volume\` CSV with no auth or crumb required.
- Yahoo Finance v8 requires a session crumb that the proxy cannot obtain — use Stooq instead.
- The proxy accepts any public HTTPS URL; no API key needed for public data sources.`;
        },
    },
    {
        name: 'python',
        type: 'rule',
        description: 'Run Python via execute_code. Body adapts to the active runtime (native subprocess or Pyodide).',
        trigger: 'python, pyodide, pandas, numpy, matplotlib, scipy, micropip',
        trigger_on_filetype: '.py, .ipynb',
        trigger_on_tool: 'write_file=>.py, write_file=>.ipynb, execute_code',
        roles: 'coder, director',
        requires_tools: 'execute_code',
        body: '',
        body_fn: () => {
            const hasNative  = typeof nativeExec === 'function';
            const hasPyodide = pyodideStatus === 'ready' || pyodideStatus === 'loading';
            const parts = ['## execute_code — Python\n\nCall `execute_code(language="python", code="...")` to run Python.\n'];
            if (hasNative) {
                const _pkgs = typeof fgPipPackages !== 'undefined' ? fgPipPackages : undefined;
                const _SHOW = [
                    ['scipy',                    'scipy'],
                    ['scikit-learn',             'scikit-learn'],
                    ['torch',                    'torch (CPU)'],
                    ['statsmodels',              'statsmodels'],
                    ['pillow',                   'Pillow'],
                    ['opencv-python-headless',   'cv2'],
                    ['nltk',                     'nltk'],
                    ['pypdf2',                   'PyPDF2'],
                    ['pymupdf',                  'pymupdf'],
                ];
                const _AVOID = ['tensorflow', 'lifelines', 'keras'];
                let _pkgNote = '';
                if (_pkgs) {
                    const _avail   = _SHOW.filter(([pip]) => _pkgs.has(pip)).map(([, label]) => label);
                    const _missing = _AVOID.filter(pip => !_pkgs.has(pip));
                    if (_avail.length)   _pkgNote += `\n- Pre-installed (no pip needed): ${_avail.join(', ')}`;
                    if (_missing.length) _pkgNote += `\n- Not installed — use lighter alternatives: ${_missing.join(', ')}`;
                }
                parts.push(`### Environment (native python3 process)
- Runs in the workspace directory — use relative paths directly
- Full filesystem and network access
- Install packages: \`execute_code(language="bash", code="pip3 install pkg")\`
- \`subprocess\`, \`os.system\` work normally
- stdout / stderr / exit_code returned; exit_code != 0 means failure${_pkgNote}`);
            }
            if (hasPyodide) parts.push(`### Environment (Pyodide / browser sandbox)
- All workspace files are pre-loaded automatically — \`open("data.csv")\` or \`open("local/data.csv")\` works directly without any prior write_file step
- Files written during execution sync back to the workspace automatically
- Top-level \`await\` supported
- Only these packages auto-load from imports: numpy, pandas, scipy, matplotlib, Pillow, scikit-learn — do not assume any other package is available
- Other packages: \`import micropip; await micropip.install(["pkg-name"])\`
- No \`subprocess\` / \`os.system\` — use \`execute_code(language="bash", ...)\` for shell commands`);
            const pyRules = [
                'Always use `language: "python"` explicitly.',
                'Check `stderr` for tracebacks; `exit_code != 0` means failure.',
            ];
            const _pyRead   = enabledTools.has('read_file');
            const _pySearch = enabledTools.has('search_workspace');
            const _pyList   = enabledTools.has('list_files');
            if (_pyRead || _pySearch) {
                const prefer = [_pyRead && '`read_file`', _pySearch && '`search_workspace`'].filter(Boolean).join(' / ');
                pyRules.push(`For pure file reading or searching, prefer ${prefer}.`);
            }
            if (_pyList) {
                pyRules.push('Do not use `execute_code` to list workspace files — use `list_files` instead.');
            }
            pyRules.push(
                '**Comments**: add one only when the WHY is non-obvious (a hidden constraint, a workaround, a subtle invariant). Do not comment what the code does — well-named identifiers already say that.',
                '**Libraries (native)**: when writing code for an existing project, check `requirements.txt` or existing imports before adding a new package — don\'t assume it\'s installed in the project environment.',
            );
            parts.push(`### Rules\n${pyRules.map(r => `- ${r}`).join('\n')}`);
            return parts.join('\n\n');
        },
    },
    {
        name: 'bash',
        type: 'rule',
        description: 'Run bash commands via execute_code. Body adapts to the active runtime (native subprocess or local sandbox).',
        trigger: 'bash, shell script, run command, terminal',
        trigger_on_filetype: '.sh, .bash, .zsh, Makefile, Dockerfile',
        trigger_on_tool: 'write_file=>.sh, write_file=>.bash, write_file=>.zsh',
        roles: 'coder, director',
        requires_tools: 'execute_code',
        body: '',
        body_fn: () => {
            const hasNative = typeof nativeExec === 'function';
            const hasLocal  = typeof getSandboxProvider === 'function' && getSandboxProvider() === 'local';
            const parts = ['## execute_code — Bash\n\nCall `execute_code(language="bash", code="...")` to run shell commands.\n'];
            if (hasNative) parts.push(`### Environment (native bash process)
- Runs in the workspace directory — relative paths work directly
- Full shell access: grep, sed, awk, jq, find, git, python3, pip3, npm, etc.
- stdout / stderr / exit_code returned; exit_code != 0 means failure
- 2-minute timeout per call`);
            if (hasLocal) parts.push(`### Environment (local sandbox server)
- Workspace files available at the working directory via relative paths
- Full shell access; files written sync back automatically
- Do NOT use \`/workspace/\` absolute paths — use relative paths or \`$PWD\``);
            if (!hasNative && !hasLocal) parts.push('*Bash execution is not available in this environment.*');
            const bashRules = [
                'Always use `language: "bash"` explicitly.',
                'Prefer single multi-step scripts over chained execute_code calls to reduce round-trips.',
                'Check `exit_code` — non-zero means failure; read `stderr` for the reason.',
            ];
            const _bashRead   = enabledTools.has('read_file');
            const _bashSearch = enabledTools.has('search_workspace');
            const _bashGit    = enabledTools.has('run_git');
            if (_bashRead || _bashSearch) {
                const prefer = [_bashRead && '`read_file`', _bashSearch && '`search_workspace`'].filter(Boolean).join(' / ');
                bashRules.push(`For pure file reading or searching, prefer ${prefer}.`);
            }
            if (_bashGit) {
                bashRules.push('Use `run_git(...)` for git operations rather than calling `git` inside bash.');
            }
            bashRules.push(
                '**PATH persistence:** each execute_code call runs in a fresh shell — `export PATH=...` in one call does NOT carry over to the next. To persist a new PATH entry: append it to `~/.bashrc` (`echo \'export PATH=$PATH:/new/dir\' >> ~/.bashrc`) and source it at the start of subsequent calls (`source ~/.bashrc && ...`), or use the full absolute path in every call.',
                '**State across calls:** installed tools, environment variables, and shell state reset between calls. Write important paths and results to workspace files immediately so they survive compaction and session restarts.',
                '**Verifying background services:** use `pgrep` or `curl` in a separate `execute_code` call — the spawning call and any external test runner use independent shells.',
            );
            parts.push(`### Rules\n${bashRules.map(r => `- ${r}`).join('\n')}`);
            return parts.join('\n\n');
        },
    },
    {
        name: 'documents',
        type: 'rule',
        description: 'Read, write, and modify document files (.pdf, .docx, .xlsx, .pptx, .odt). Examples adapt to native python3 or Pyodide.',
        trigger: 'pdf, docx, xlsx, document, spreadsheet, word, excel, powerpoint, odt, pptx',
        trigger_on_filetype: '.pdf, .docx, .doc, .xlsx, .xls, .odt, .pptx, .ppt, .ods',
        body: '',
        body_fn: () => {
            const hasNative  = typeof nativeExec === 'function';
            const hasPyodide = pyodideStatus === 'ready' || pyodideStatus === 'loading';
            const hasLocal   = typeof getSandboxProvider === 'function' && getSandboxProvider() === 'local';
            const hasExec    = enabledTools.has('execute_code');
            const hasRead    = enabledTools.has('read_file');

            const parts: string[] = [];

            if (hasRead) {
                parts.push(`## Document File Support

### Reading

\`read_file\` extracts text automatically for all document types — no special handling needed.

\`\`\`
read_file(path="report.docx")   → full text content
read_file(path="data.xlsx")     → CSV-style text, one block per sheet
read_file(path="manual.pdf")    → extracted text, one block per page
\`\`\``);
            }

            if (!hasExec) {
                if (!hasRead) return '';
                return parts.join('\n\n') + '\n\n*Modification requires a Python runtime (execute_code).*';
            }

            const hasWrite = enabledTools.has('write_file');

            if (hasNative && hasWrite) {
                parts.push(`### Writing / Modifying — native python3

Install packages first, then run Python. Files are at their workspace path (cwd = workspace root).

**Install:** \`execute_code(language="bash", code="pip3 install python-docx openpyxl python-pptx fpdf2 pypdf markdown htmldocx")\`

#### Modify a .docx
\`\`\`python
import base64, io
from docx import Document

doc = Document('report.docx')
for para in doc.paragraphs:
    if 'old text' in para.text:
        para.text = para.text.replace('old text', 'new text')
buf = io.BytesIO(); doc.save(buf)
print(base64.b64encode(buf.getvalue()).decode())
\`\`\`
Then: \`write_file(path="report.docx", content=<base64 output>, encoding="base64")\`

#### Modify a .xlsx
\`\`\`python
import base64, io
from openpyxl import load_workbook

wb = load_workbook('data.xlsx')
ws = wb.active
ws['A1'] = 'Updated value'
buf = io.BytesIO(); wb.save(buf)
print(base64.b64encode(buf.getvalue()).decode())
\`\`\`
Then: \`write_file(path="data.xlsx", content=<base64 output>, encoding="base64")\`

#### Create a .docx from markdown
\`\`\`python
import base64, io
from docx import Document
from htmldocx import HtmlToDocx
import markdown as md_lib

content = "# Title\\n\\nParagraph."
doc = Document()
HtmlToDocx().add_html_to_document(md_lib.markdown(content), doc)
buf = io.BytesIO(); doc.save(buf)
print(base64.b64encode(buf.getvalue()).decode())
\`\`\`

#### Create a PDF from markdown
\`\`\`python
import base64, io
from fpdf import FPDF
import markdown as md_lib

pdf = FPDF(); pdf.add_page(); pdf.set_margins(20, 20, 20); pdf.set_font('Helvetica', size=12)
pdf.write_html(md_lib.markdown("# Title\\n\\nParagraph."))
buf = io.BytesIO(); pdf.output(buf)
print(base64.b64encode(buf.getvalue()).decode())
\`\`\`

#### Merge / extract PDF pages
\`\`\`python
import base64, io
from pypdf import PdfReader, PdfWriter

reader = PdfReader('doc.pdf'); writer = PdfWriter()
for page in reader.pages[:5]: writer.add_page(page)
buf = io.BytesIO(); writer.write(buf)
print(base64.b64encode(buf.getvalue()).decode())
\`\`\`

**Key rule:** Never \`write_file\` with raw text for binary formats (.docx, .xlsx, .pdf). Always encode as base64.`);
            }

            if (hasPyodide && hasWrite) {
                parts.push(`### Writing / Modifying — Pyodide (browser)

Files are pre-loaded at \`/workspace/<path>\`. Use \`await micropip.install([...])\` for packages.

#### Modify a .docx
\`\`\`python
import base64, io, micropip
await micropip.install(['python-docx'])
from docx import Document

doc = Document('/workspace/report.docx')
for para in doc.paragraphs:
    if 'old text' in para.text:
        para.text = para.text.replace('old text', 'new text')
buf = io.BytesIO(); doc.save(buf)
print(base64.b64encode(buf.getvalue()).decode())
\`\`\`
Then: \`write_file(path="report.docx", content=<base64 output>, encoding="base64")\`

#### Modify a .xlsx
\`\`\`python
import base64, io, micropip
await micropip.install(['openpyxl'])
from openpyxl import load_workbook

wb = load_workbook('/workspace/data.xlsx'); ws = wb.active; ws['A1'] = 'Updated'
buf = io.BytesIO(); wb.save(buf)
print(base64.b64encode(buf.getvalue()).decode())
\`\`\`

**Key rule:** Never \`write_file\` with raw text for binary formats. Always encode as base64.`);
            }

            if (hasLocal && hasWrite) {
                parts.push(`### Heavy PDF editing — pymupdf (local server)

\`\`\`python
import base64, io
import fitz  # pymupdf — available when fg_sandbox_provider=local

doc = fitz.open('/workspace/doc.pdf')
doc[0].insert_text((100, 100), 'Annotation')
buf = io.BytesIO(); doc.save(buf)
print(base64.b64encode(buf.getvalue()).decode())
\`\`\`
Check: \`execute_code(language="bash", code="python3 -c 'import fitz; print(fitz.__version__)'")\``);
            }

            if (hasWrite) {
                parts.push('**Size note:** Base64 adds ~33% overhead. Files over ~3 MB produce large outputs — split by page range (PDF) or sheet (XLSX).');
            }
            return parts.join('\n\n');
        },
    },
];

const _storedBuiltins = JSON.parse(localStorage.getItem('fg_builtin_skills') || 'null');
const enabledBuiltinSkills = new Set(
    _storedBuiltins !== null ? _storedBuiltins : BUILTIN_SKILLS.map(s => s.name)
);

const _storedBuiltinRules = JSON.parse(localStorage.getItem('fg_builtin_rules') || 'null');
const enabledBuiltinRules = new Set(
    _storedBuiltinRules !== null ? _storedBuiltinRules : BUILTIN_RULES.map(r => r.name)
);

export async function loadSkills() {
    skillsRegistry.clear();
    // Built-in skills (procedural; trigger-invoked like rules — there is no slash dispatcher)
    for (const skill of BUILTIN_SKILLS) {
        if (enabledBuiltinSkills.has(skill.name)) {
            skillsRegistry.set(skill.name, { ...skill, type: 'skill', path: 'builtin' });
        }
    }
    // Built-in rules (standing context, trigger-injected)
    for (const rule of BUILTIN_RULES) {
        if (enabledBuiltinRules.has(rule.name)) {
            skillsRegistry.set(rule.name, { ...rule, type: 'rule', path: 'builtin' });
        }
    }
    try {
        // agentListFilesInDir scans only skills/ and rules/ — avoids a full workspace
        // walk (which can be very slow in large repos: 64K files × per-tick JSDOM overhead).
        // Falls back to full agentListFiles() if the fast path is not available.
        let skillFiles: Array<{name:string}> = [];
        let ruleFiles:  Array<{name:string}> = [];
        if (typeof agentListFilesInDir === 'function') {
            [skillFiles, ruleFiles] = await Promise.all([
                agentListFilesInDir('skills').catch(() => []),
                agentListFilesInDir('rules').catch(() => []),
            ]);
            // Normalise paths relative to workspace root so patterns match
            skillFiles = skillFiles.map(f => ({ ...f, name: `skills/${f.name}` }));
            ruleFiles  = ruleFiles.map(f => ({ ...f, name: `rules/${f.name}` }));
        } else {
            const files = await agentListFiles();
            skillFiles = files.filter(f =>
                /^(?:local\/)?skills\/[^/]+\/SKILL\.md$/i.test(f.name) ||
                /^(?:local\/)?skills\/[^/]+\.skill\.md$/i.test(f.name)
            );
            ruleFiles = files.filter(f =>
                /^(?:local\/)?rules\/[^/]+\/RULE\.md$/i.test(f.name) ||
                /^(?:local\/)?rules\/[^/]+\.rule\.md$/i.test(f.name)
            );
        }

        // Helper: parse and register one markdown file
        const _load = async (f, type) => {
            try {
                const content = await agentReadFile(f.name);
                const fm = parseFrontmatter(content);
                if (!fm.name) return;
                const norm = content.replace(/\r\n/g, '\n');
                const body = norm.replace(/^---[ \t]*\n[\s\S]*?\n---[ \t]*\n/, '').trim();
                skillsRegistry.set(fm.name, { name: fm.name, description: fm.description || '', trigger: fm.trigger || '', requires_tools: fm.requires_tools || '', roles: fm.roles || '', exclude_roles: fm.exclude_roles || '', exclude_mode: fm.exclude_mode || '', trigger_on_tool: fm.trigger_on_tool || '', trigger_on_failure: fm.trigger_on_failure || '', trigger_on_event: fm.trigger_on_event || '', trigger_on_filetype: fm.trigger_on_filetype || '', trigger_on_media: fm.trigger_on_media || '', trigger_on_file_present: fm.trigger_on_file_present || '', trigger_on_message_pattern: fm.trigger_on_message_pattern || '', trigger_on_history_tool: fm.trigger_on_history_tool || '', trigger_on_turn: fm.trigger_on_turn || '', trigger_on_repeat: fm.trigger_on_repeat || '', trigger_on_completion: fm.trigger_on_completion || '', body, path: f.name, type });
            } catch {}
        };

        // Re-filter with patterns after path normalisation (works for both code paths)
        const finalSkillFiles = skillFiles.filter(f =>
            /^(?:local\/)?skills\/[^/]+\/SKILL\.md$/i.test(f.name) ||
            /^(?:local\/)?skills\/[^/]+\.skill\.md$/i.test(f.name)
        );
        const finalRuleFiles = ruleFiles.filter(f =>
            /^(?:local\/)?rules\/[^/]+\/RULE\.md$/i.test(f.name) ||
            /^(?:local\/)?rules\/[^/]+\.rule\.md$/i.test(f.name)
        );
        await Promise.all([
            ...finalSkillFiles.map(f => _load(f, 'skill')),
            ...finalRuleFiles.map(f => _load(f, 'rule')),
        ]);
    } catch {}
    // Apply per-entry overrides saved by the user (triggers + body)
    const _overrides = _getSkillTriggerOverrides();
    for (const [name, ov] of Object.entries(_overrides)) {
        const s = skillsRegistry.get(name);
        if (!s) continue;
        const TFIELDS = ['trigger','trigger_on_filetype','trigger_on_tool','trigger_on_failure','trigger_on_event','trigger_on_media','trigger_on_file_present','trigger_on_message_pattern','trigger_on_history_tool','trigger_on_turn','trigger_on_repeat','body'];
        for (const f of TFIELDS) { if (f in (ov as any)) (s as any)[f] = (ov as any)[f]; }
    }
    renderSkillsList();
    renderSkillsChecklist();
}

function _renderSkillCards(el, entries, typeLabel) {
    if (!entries.length) return;
    const hdr = document.createElement('div');
    hdr.style.cssText = 'font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.05em;color:var(--muted);margin:10px 0 6px;padding-bottom:4px;border-bottom:1px solid var(--border)';
    hdr.textContent = typeLabel;
    el.appendChild(hdr);
    for (const s of entries) {
        const card = document.createElement('div');
        card.className = 'skill-card' + (activeSkills.has(s.name) ? ' skill-card-active' : '');
        const hdrRow = document.createElement('div');
        hdrRow.className = 'skill-card-hdr';
        const nameEl = document.createElement('span');
        nameEl.className = 'skill-card-name';
        nameEl.textContent = '/' + s.name;
        const tog = document.createElement('button');
        tog.className = 'skill-toggle' + (activeSkills.has(s.name) ? ' skill-toggle-on' : '');
        tog.textContent = activeSkills.has(s.name) ? 'Always on' : 'Off';
        tog.title = 'Toggle persistent activation (injected into every system prompt)';
        tog.onclick = () => toggleSkill(s.name);
        hdrRow.append(nameEl, tog);
        const desc = document.createElement('div');
        desc.className = 'skill-card-desc';
        desc.textContent = s.description || '(no description)';
        card.append(hdrRow, desc);
        el.appendChild(card);
    }
}

function renderSkillsList() {
    const el = (document.getElementById('skills-list') as HTMLInputElement);
    if (!el) return;
    el.innerHTML = '';
    if (!skillsRegistry.size) {
        const msg = document.createElement('div');
        msg.className = 'skills-empty';
        msg.innerHTML = 'No skills or rules installed yet.<br><br>'
            + 'Skills: write a procedure to <code>skills/name/SKILL.md</code>.<br>'
            + 'Rules: write standing context to <code>rules/name/RULE.md</code>.';
        el.appendChild(msg);
        return;
    }
    const skills = [...skillsRegistry.values()].filter(s => s.type !== 'rule');
    const rules  = [...skillsRegistry.values()].filter(s => s.type === 'rule');
    _renderSkillCards(el, skills, 'Skills');
    _renderSkillCards(el, rules, 'Rules');
}

function toggleSkill(name) {
    if (activeSkills.has(name)) activeSkills.delete(name);
    else activeSkills.add(name);
    localStorage.setItem('fg_active_skills', JSON.stringify([...activeSkills]));
    renderSkillsList();
    renderSkillsChecklist();
}

async function installSkillFromFiles() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.md';
    input.multiple = true;
    input.onchange = async () => {
        let installed = 0;
        for (const file of input.files) {
            try {
                const text = await file.text();
                const fm = parseFrontmatter(text);
                if (!fm.name) { alert(`Skipped ${file.name}: no "name:" in frontmatter`); continue; }
                await agentWriteFile(`skills/${fm.name}/SKILL.md`, text);
                installed++;
            } catch (e) { alert(`Failed to install ${file.name}: ${e.message}`); }
        }
        if (installed) await loadSkills();
    };
    input.click();
}

function switchSkillSubtab(tab) {
    const panels = { installed: 'skill-sub-installed', add: 'skill-sub-add', 'add-rule': 'skill-sub-add-rule' };
    const btns   = { installed: 'skill-subtab-installed', add: 'skill-subtab-add', 'add-rule': 'skill-subtab-add-rule' };
    for (const [key, id] of Object.entries(panels)) {
        const el = (document.getElementById(id) as HTMLInputElement);
        if (el) el.style.display = key === tab ? '' : 'none';
    }
    for (const [key, id] of Object.entries(btns)) {
        (document.getElementById(id) as HTMLInputElement)?.classList.toggle('active', key === tab);
    }
    if (tab === 'installed') {
        ['new-skill-msg', 'new-rule-msg'].forEach(id => { const el = (document.getElementById(id) as HTMLInputElement); if (el) el.style.display = 'none'; });
    }
}

async function createSkillFromForm() {
    const nameEl = (document.getElementById('new-skill-name') as HTMLInputElement);
    const descEl = (document.getElementById('new-skill-desc') as HTMLInputElement);
    const bodyEl = (document.getElementById('new-skill-body') as HTMLInputElement);
    const msgEl  = (document.getElementById('new-skill-msg') as HTMLInputElement);

    const name = (nameEl?.value || '').trim().replace(/\s+/g, '-').toLowerCase();
    const desc = (descEl?.value || '').trim();
    const body = (bodyEl?.value || '').trim();

    if (!name) { if (msgEl) { msgEl.textContent = '⚠ Skill name is required.'; msgEl.style.color = '#d32f2f'; msgEl.style.display = ''; } return; }
    if (!body) { if (msgEl) { msgEl.textContent = '⚠ Skill content is required.'; msgEl.style.color = '#d32f2f'; msgEl.style.display = ''; } return; }

    const frontmatter = `---\nname: ${name}${desc ? `\ndescription: ${desc}` : ''}\n---\n\n`;
    const content = frontmatter + body;

    try {
        await agentWriteFile(`skills/${name}/SKILL.md`, content);
        if (nameEl) nameEl.value = '';
        if (descEl) descEl.value = '';
        if (bodyEl) bodyEl.value = '';
        if (msgEl) { msgEl.textContent = `✓ Skill "${name}" saved.`; msgEl.style.color = 'var(--accent)'; msgEl.style.display = ''; }
        await loadSkills();
        setTimeout(() => switchSkillSubtab('installed'), 800);
    } catch (e) {
        if (msgEl) { msgEl.textContent = `Error: ${e.message}`; msgEl.style.color = '#d32f2f'; msgEl.style.display = ''; }
    }
}

async function createRuleFromForm() {
    const nameEl    = (document.getElementById('new-rule-name') as HTMLInputElement);
    const descEl    = (document.getElementById('new-rule-desc') as HTMLInputElement);
    const triggerEl = (document.getElementById('new-rule-trigger') as HTMLInputElement);
    const bodyEl    = (document.getElementById('new-rule-body') as HTMLInputElement);
    const msgEl     = (document.getElementById('new-rule-msg') as HTMLInputElement);

    const name    = (nameEl?.value || '').trim().replace(/\s+/g, '-').toLowerCase();
    const desc    = (descEl?.value || '').trim();
    const trigger = (triggerEl?.value || '').trim();
    const body    = (bodyEl?.value || '').trim();

    if (!name) { if (msgEl) { msgEl.textContent = '⚠ Rule name is required.'; msgEl.style.color = '#d32f2f'; msgEl.style.display = ''; } return; }
    if (!body) { if (msgEl) { msgEl.textContent = '⚠ Rule content is required.'; msgEl.style.color = '#d32f2f'; msgEl.style.display = ''; } return; }

    const frontmatter = `---\nname: ${name}${desc ? `\ndescription: ${desc}` : ''}${trigger ? `\ntrigger: ${trigger}` : ''}\n---\n\n`;
    try {
        await agentWriteFile(`rules/${name}/RULE.md`, frontmatter + body);
        if (nameEl) nameEl.value = '';
        if (descEl) descEl.value = '';
        if (triggerEl) triggerEl.value = '';
        if (bodyEl) bodyEl.value = '';
        if (msgEl) { msgEl.textContent = `✓ Rule "${name}" saved.`; msgEl.style.color = 'var(--accent)'; msgEl.style.display = ''; }
        await loadSkills();
        setTimeout(() => switchSkillSubtab('installed'), 800);
    } catch (e) {
        if (msgEl) { msgEl.textContent = `Error: ${e.message}`; msgEl.style.color = '#d32f2f'; msgEl.style.display = ''; }
    }
}

// ── Skill trigger overrides ────────────────────────────────────────────────
// Stored as fg_skill_triggers: { skillName: { trigger, trigger_on_filetype, ... } }
// Only fields the user has explicitly edited are stored; others fall through to
// the skill's built-in / SKILL.md defaults.
const _TRIGGER_FIELDS = [
    { key: 'trigger',             label: 'Keywords' },
    { key: 'trigger_on_filetype', label: 'Filetypes' },
    { key: 'trigger_on_tool',     label: 'On tool' },
    { key: 'trigger_on_failure',  label: 'On failure' },
    { key: 'trigger_on_event',    label: 'On event' },
    { key: 'trigger_on_media',    label: 'On media' },
    { key: 'trigger_on_file_present',    label: 'File present' },
    { key: 'trigger_on_message_pattern', label: 'Msg pattern' },
    { key: 'trigger_on_history_tool',    label: 'History tool' },
    { key: 'trigger_on_turn',            label: 'On turn' },
];

function _getSkillTriggerOverrides() {
    try { return JSON.parse(localStorage.getItem('fg_skill_triggers') || '{}'); } catch { return {}; }
}

function _saveSkillTriggerOverride(skillName, fieldKey, value) {
    const all = _getSkillTriggerOverrides();
    if (!all[skillName]) all[skillName] = {};
    all[skillName][fieldKey] = value;
    localStorage.setItem('fg_skill_triggers', JSON.stringify(all));
}

function _resetSkillTriggerOverrides(skillName) {
    const all = _getSkillTriggerOverrides();
    delete all[skillName];
    localStorage.setItem('fg_skill_triggers', JSON.stringify(all));
}

// Build the trigger-editor block for one skill in the checklist.
// Shows each trigger field as a compact chip when collapsed, inline textarea when expanded.
function _buildSkillTriggerEditor(skill) {
    const overrides = _getSkillTriggerOverrides()[skill.name] || {};
    const wrap = document.createElement('div');
    wrap.className = 'skill-trigger-wrap';

    const editBtn = document.createElement('button');
    editBtn.className = 'skill-trigger-edit-btn';
    editBtn.textContent = 'Edit skill';
    wrap.appendChild(editBtn);

    // Editor panel (hidden until editBtn clicked)
    const editor = document.createElement('div');
    editor.className = 'skill-trigger-editor';
    editor.style.display = 'none';

    // Helper: one labelled textarea field
    const _field = (key, label, rows) => {
        const row = document.createElement('div');
        row.style.cssText = 'margin-bottom:10px';
        const lbl = document.createElement('label');
        lbl.style.cssText = 'display:block;font-size:11px;font-weight:600;color:var(--muted);margin-bottom:3px;text-transform:uppercase;letter-spacing:0.04em';
        lbl.textContent = label;
        const defaultVal = key === 'body' ? (skill.body || '') : (skill[key] || '');
        const currentVal = overrides[key] !== undefined ? overrides[key] : defaultVal;
        const ta = document.createElement('textarea');
        ta.className = 'skill-trigger-input' + (overrides[key] !== undefined ? ' skill-trigger-input-custom' : '');
        ta.value = currentVal;
        ta.placeholder = key === 'body' ? '(no instructions)' : (defaultVal || '(none)');
        ta.rows = rows;
        ta.dataset.field = key;
        ta.dataset.default = defaultVal;
        if (key === 'body') ta.style.fontFamily = '"SF Mono","Fira Code",monospace';
        ta.addEventListener('input', () => ta.classList.toggle('skill-trigger-input-custom', ta.value !== ta.dataset.default));
        row.append(lbl, ta);
        return row;
    };

    // Instructions first
    editor.appendChild(_field('body', 'Instructions', 12));

    // Divider
    const sep = document.createElement('div');
    sep.style.cssText = 'border-top:1px solid var(--border);margin:4px 0 12px';
    editor.appendChild(sep);

    // Trigger fields
    for (const { key, label } of _TRIGGER_FIELDS) {
        editor.appendChild(_field(key, label, 2));
    }

    // Buttons
    const btnRow = document.createElement('div');
    btnRow.style.cssText = 'display:flex;gap:6px;margin-top:4px';
    const saveBtn = document.createElement('button');
    saveBtn.className = 'skill-trigger-save-btn';
    saveBtn.textContent = 'Save';
    const resetBtn = document.createElement('button');
    resetBtn.className = 'skill-trigger-reset-btn';
    resetBtn.textContent = 'Reset to defaults';
    btnRow.append(saveBtn, resetBtn);
    editor.appendChild(btnRow);
    wrap.appendChild(editor);

    editBtn.addEventListener('click', () => {
        const open = editor.style.display !== 'none';
        editor.style.display = open ? 'none' : '';
        editBtn.textContent = open ? 'Edit skill' : 'Close';
    });

    saveBtn.addEventListener('click', () => {
        const all = _getSkillTriggerOverrides();
        if (!all[skill.name]) all[skill.name] = {};
        for (const ta of (editor.querySelectorAll('textarea[data-field]') as NodeListOf<HTMLTextAreaElement>)) {
            const val = ta.value;   // preserve whitespace in body
            if (val !== ta.dataset.default) {
                overrides[ta.dataset.field] = val;
                all[skill.name][ta.dataset.field] = val;
            } else {
                delete overrides[ta.dataset.field];
                delete all[skill.name][ta.dataset.field];
            }
        }
        if (!Object.keys(all[skill.name]).length) delete all[skill.name];
        localStorage.setItem('fg_skill_triggers', JSON.stringify(all));
        loadSkills();
        editor.style.display = 'none';
        editBtn.textContent = 'Edit skill';
    });

    resetBtn.addEventListener('click', () => {
        _resetSkillTriggerOverrides(skill.name);
        for (const f of Object.keys(overrides)) delete overrides[f];
        for (const ta of (editor.querySelectorAll('textarea[data-field]') as NodeListOf<HTMLTextAreaElement>)) {
            ta.value = ta.dataset.default;
            ta.classList.remove('skill-trigger-input-custom');
        }
        loadSkills();
    });

    return wrap;
}

function _skillChecklistSection(el, label, hint) {
    const hdr = document.createElement('p');
    hdr.style.cssText = 'font-size:11px;text-transform:uppercase;letter-spacing:0.05em;color:var(--muted);margin:0 0 6px';
    hdr.textContent = label;
    el.appendChild(hdr);
    if (hint) {
        const h = document.createElement('p');
        h.style.cssText = 'font-size:11px;color:var(--muted);margin:0 0 8px';
        h.textContent = hint;
        el.appendChild(h);
    }
}

function _buildSkillChecklistItem(skill, isBuiltin) {
    const isRule = skill.type === 'rule';
    const wrap = document.createElement('div');
    wrap.className = 'model-checklist-item skill-checklist-item';

    const cb = document.createElement('input');
    cb.type    = 'checkbox';
    cb.checked = isBuiltin
        ? (isRule ? enabledBuiltinRules.has(skill.name) : enabledBuiltinSkills.has(skill.name))
        : activeSkills.has(skill.name);
    cb.style.cssText = 'margin-top:2px;flex-shrink:0;cursor:pointer';
    cb.addEventListener('change', () => {
        if (isBuiltin) {
            if (isRule) {
                if (cb.checked) enabledBuiltinRules.add(skill.name);
                else enabledBuiltinRules.delete(skill.name);
                localStorage.setItem('fg_builtin_rules', JSON.stringify([...enabledBuiltinRules]));
            } else {
                if (cb.checked) enabledBuiltinSkills.add(skill.name);
                else enabledBuiltinSkills.delete(skill.name);
                localStorage.setItem('fg_builtin_skills', JSON.stringify([...enabledBuiltinSkills]));
            }
            loadSkills();
        } else {
            if (cb.checked) activeSkills.add(skill.name);
            else activeSkills.delete(skill.name);
            localStorage.setItem('fg_active_skills', JSON.stringify([...activeSkills]));
            renderSkillsList();
        }
    });

    // Look up the live registry entry (has overrides applied) for accurate trigger display
    const live = skillsRegistry.get(skill.name) || skill;

    const info = document.createElement('div');
    info.className = 'model-item-info';
    info.style.minWidth = '0';
    const nameEl = document.createElement('div');
    nameEl.className = 'model-item-name';
    nameEl.textContent = '/' + skill.name;
    const descEl = document.createElement('div');
    descEl.className = 'model-item-meta';
    descEl.textContent = skill.description || '(no description)';
    info.append(nameEl, descEl, _buildSkillTriggerEditor(live));

    wrap.append(cb, info);
    return wrap;
}

function _checklistBlock(el, heading, hint, items, isBuiltin) {
    if (!items.length) return;
    _skillChecklistSection(el, heading, hint);
    for (const s of items) el.appendChild(_buildSkillChecklistItem(s, isBuiltin));
}

function renderSkillsChecklist() {
    const el = (document.getElementById('settings-skills-list') as HTMLInputElement);
    if (!el) return;
    el.innerHTML = '';

    const fileSkills = [...skillsRegistry.values()].filter(s => s.path !== 'builtin' && s.type !== 'rule');
    const fileRules  = [...skillsRegistry.values()].filter(s => s.path !== 'builtin' && s.type === 'rule');

    // ── Skills ───────────────────────────────────────────────────────────────
    const skillsHdr = document.createElement('div');
    skillsHdr.style.cssText = 'font-size:13px;font-weight:700;color:var(--text);margin-bottom:10px';
    skillsHdr.textContent = 'Skills';
    el.appendChild(skillsHdr);

    _checklistBlock(el, 'Built-in', 'Procedural workflows invoked with /name.', BUILTIN_SKILLS, true);

    if (fileSkills.length) {
        const sep = document.createElement('div');
        sep.style.cssText = 'border-top:1px solid var(--border);margin:10px 0 8px';
        el.appendChild(sep);
        _checklistBlock(el, 'Installed', 'Checked skills are always injected into the system prompt.', fileSkills, false);
    }

    // ── Rules ─────────────────────────────────────────────────────────────────
    const rulesSep = document.createElement('div');
    rulesSep.style.cssText = 'border-top:2px solid var(--border);margin:16px 0 12px';
    el.appendChild(rulesSep);

    const rulesHdr = document.createElement('div');
    rulesHdr.style.cssText = 'font-size:13px;font-weight:700;color:var(--text);margin-bottom:10px';
    rulesHdr.textContent = 'Rules';
    el.appendChild(rulesHdr);

    _checklistBlock(el, 'Built-in', 'Standing context injected when triggered (keyword, filetype, tool result).', BUILTIN_RULES, true);

    if (fileRules.length) {
        const sep2 = document.createElement('div');
        sep2.style.cssText = 'border-top:1px solid var(--border);margin:10px 0 8px';
        el.appendChild(sep2);
        _checklistBlock(el, 'Installed', 'Checked rules are always injected into the system prompt.', fileRules, false);
    }
}

function renderToolsChecklist() {
    const el = (document.getElementById('settings-tools-list') as HTMLInputElement);
    if (!el) return;
    el.innerHTML = '';
    for (const name of ALL_TOOL_NAMES) {
        const item = document.createElement('label');
        item.className = 'model-checklist-item';
        const cb = document.createElement('input');
        cb.type    = 'checkbox';
        cb.checked = enabledTools.has(name);
        cb.addEventListener('change', () => {
            if (cb.checked) enabledTools.add(name);
            else enabledTools.delete(name);
            // Persist the disabled set (see config.js) so future tools default to on.
            localStorage.setItem('fg_disabled_tools',
                JSON.stringify(ALL_TOOL_NAMES.filter(t => !enabledTools.has(t))));
        });
        const info = document.createElement('div');
        info.className = 'model-item-info';
        info.innerHTML = `<div class="model-item-name">${TOOL_LABELS[name] || name}</div><div class="model-item-meta">${TOOL_DESCRIPTIONS[name] || ''}</div>`;
        item.append(cb, info);
        el.appendChild(item);
    }
}

let _skillAutocompleteSetup = false;
function setupSkillAutocomplete() {
    if (_skillAutocompleteSetup) return;
    const input    = (document.getElementById('agent-input') as HTMLInputElement);
    const dropdown = (document.getElementById('skill-autocomplete') as HTMLInputElement);
    if (!input || !dropdown) return;
    _skillAutocompleteSetup = true;

    let selectedIdx = -1;
    // Outside-click handler — stored so removeEventListener gets the same reference.
    // Registered on document only while the dropdown is open; removed when it hides.
    const _onDocClick = (e: MouseEvent) => {
        if (!dropdown.contains(e.target as Node) && e.target !== input) hideDropdown();
    };

    function getItems() { return [...dropdown.querySelectorAll('.skill-ac-item')]; }

    function showDropdown(matches) {
        dropdown.innerHTML = '';
        selectedIdx = -1;
        for (const skill of matches) {
            const item = document.createElement('div');
            item.className = 'skill-ac-item';
            item.dataset.name = skill.name;
            const nameEl = document.createElement('span');
            nameEl.className = 'skill-ac-name';
            nameEl.textContent = '/' + skill.name;
            const descEl = document.createElement('span');
            descEl.className = 'skill-ac-desc';
            descEl.textContent = skill.description;
            item.append(nameEl, descEl);
            item.addEventListener('mousedown', e => {
                e.preventDefault();
                applySkill(skill.name);
            });
            dropdown.appendChild(item);
        }
        const rect = input.getBoundingClientRect();
        dropdown.style.left   = rect.left + 'px';
        dropdown.style.width  = Math.max(rect.width, 320) + 'px';
        dropdown.style.bottom = (window.innerHeight - rect.top + 4) + 'px';
        dropdown.style.top    = 'auto';
        if (dropdown.style.display === 'none') {
            // Attach outside-click guard only when opening — removed in hideDropdown.
            document.addEventListener('click', _onDocClick);
        }
        dropdown.style.display = 'block';
    }

    function hideDropdown() {
        if (dropdown.style.display !== 'none') {
            document.removeEventListener('click', _onDocClick);
        }
        dropdown.style.display = 'none';
        selectedIdx = -1;
    }

    function applySkill(name) {
        _setInputText(input, '/' + name + ' ');
        hideDropdown();
        input.focus();
        autoResizeTextarea(input);
    }

    // UI commands handled directly by agent-core (not LLM skills) but shown in autocomplete.
    const _UI_COMMANDS = [
        { name: 'model-update', description: 'Check providers for new or removed free models and update the catalog', type: 'ui-command' },
        { name: 'compact',      description: 'Compact conversation history to free up context',                       type: 'ui-command' },
    ];

    input.addEventListener('input', () => {
        const val = input.innerText || '';
        if (!val.startsWith('/') || val.includes('\n')) { hideDropdown(); return; }
        const query = val.slice(1).toLowerCase();
        if (query.includes(' ')) { hideDropdown(); return; }
        const skillMatches = [...skillsRegistry.values()].filter(s => s.name.startsWith(query));
        const uiMatches    = _UI_COMMANDS.filter(c => c.name.startsWith(query));
        const matches = [...uiMatches, ...skillMatches];
        if (!matches.length) { hideDropdown(); return; }
        showDropdown(matches);
    });

    input.addEventListener('keydown', e => {
        if (dropdown.style.display === 'none') return;
        const items = getItems();
        if (e.key === 'ArrowDown') {
            e.preventDefault();
            selectedIdx = Math.min(selectedIdx + 1, items.length - 1);
            items.forEach((it, i) => it.classList.toggle('selected', i === selectedIdx));
        } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            selectedIdx = Math.max(selectedIdx - 1, 0);
            items.forEach((it, i) => it.classList.toggle('selected', i === selectedIdx));
        } else if (e.key === 'Tab' || (e.key === 'Enter' && selectedIdx >= 0)) {
            e.preventDefault();
            const sel = items[selectedIdx] ?? items[0];
            if (sel) applySkill((sel as HTMLElement).dataset.name);
        } else if (e.key === 'Escape') {
            hideDropdown();
        }
    });
}

// Window bridge for classic scripts and inline handlers (ESM migration).
Object.assign(window, { BUILTIN_SKILLS, BUILTIN_RULES, loadSkills, renderSkillsList, toggleSkill, installSkillFromFiles, switchSkillSubtab, createSkillFromForm, createRuleFromForm, _TRIGGER_FIELDS, renderSkillsChecklist, renderToolsChecklist, setupSkillAutocomplete });
