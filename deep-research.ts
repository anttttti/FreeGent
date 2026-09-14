// deep-research.js — FreeGent: iterative deep-research engine (IterResearch pattern)
// Think→Search→Extract→Synthesize loop where the evolving report is the only persistent
// state — raw search results and page text are discarded after each synthesis round, so
// no LLM call ever needs more than ~20k tokens of context regardless of research depth.
// All LLM calls go through callLLMComplete (fully routed: rate limits, retry, rotation).
// Depends on: config.js, workers.js (callLLMComplete), tools.js (executeToolAsync),
//             state.js (softStopPending, activePlaceholder).
import { softStopPending, activePlaceholder } from './state.js';

const _DR_MAX_ROUNDS        = 4;       // default rounds; arg-overridable up to 6
const _DR_QUERIES_PER_ROUND = 4;
const _DR_PAGES_PER_ROUND   = 4;
const _DR_REPORT_MAX_CHARS  = 24_000;  // ~6k tokens — synthesis keeps the report under this
const _DR_EXTRACT_CHUNK     = 40_000;  // ~10k tokens per extraction call
const _DR_CHUNKS_PER_PAGE   = 2;       // cap extraction calls per page
const _DR_FINDINGS_MAX      = 36_000;  // ~9k tokens of findings fed into one synthesis call

function _drDateContext() {
    const now = new Date();
    return `Today's date is ${now.toISOString().slice(0, 10)}. When a query needs a year or refers to "latest"/"current", use ${now.getFullYear()} — never a year inferred from training data.`;
}

// Tolerant JSON extraction: fenced block first, then first bracket-balanced candidate.
function _drJson(text, want = 'any') {
    if (typeof text !== 'string' || !text) return null;
    const fenced = text.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
    const candidates = [];
    if (fenced) candidates.push(fenced[1].trim());
    const arr = text.match(/\[[\s\S]*\]/);  if (arr) candidates.push(arr[0]);
    const obj = text.match(/\{[\s\S]*\}/);  if (obj) candidates.push(obj[0]);
    for (const c of candidates) {
        try {
            const v = JSON.parse(c);
            if (want === 'array'  && !Array.isArray(v)) continue;
            if (want === 'object' && (Array.isArray(v) || typeof v !== 'object')) continue;
            return v;
        } catch {}
    }
    return null;
}

async function _drPlan(question) {
    const prompt = `${_drDateContext()}

You are a research strategist. Before searching, break this question down.

**Question:** ${question}

Return a JSON object:
{
  "sub_questions": ["3-6 specific sub-questions to investigate"],
  "key_topics": ["key topics/angles to cover"],
  "success_criteria": "one sentence: what a complete answer looks like"
}
Return ONLY the JSON object.`;
    const resp = await callLLMComplete(prompt, { maxTokens: 2048, label: 'research:plan' }).catch(() => null);
    return _drJson(resp, 'object');
}

async function _drQueries(state) {
    const roundInstruction = state.round === 1
        ? 'This is the first round — cover the main sub-questions broadly.'
        : `Target ONLY what the report is still missing. Known gaps: ${state.gaps || '(reassess from the report)'}. Do not repeat earlier queries: ${[...state.pastQueries].slice(-12).join('; ')}`;
    const prompt = `${_drDateContext()}

You plan web searches for a research question.

**Question:** ${state.question}
${state.plan ? `**Research plan:** ${JSON.stringify(state.plan)}` : ''}
**Current report (what we know so far):**
${state.report || '(nothing yet)'}

**Round ${state.round}.** ${roundInstruction}

Generate ${_DR_QUERIES_PER_ROUND} focused search queries.
Return ONLY a JSON array of query strings.`;
    const resp = await callLLMComplete(prompt, { maxTokens: 1024, label: 'research:queries' }).catch(() => null);
    const arr = _drJson(resp, 'array');
    return Array.isArray(arr) ? arr.filter(q => typeof q === 'string' && q.trim()).slice(0, _DR_QUERIES_PER_ROUND) : [];
}

// Run all queries in parallel; return deduped results [{title,url,snippet,hits}] ranked by
// how many distinct queries surfaced the URL (cross-query hits = likely central source).
async function _drSearch(queries, visited) {
    const settled = await Promise.all(queries.map(q =>
        executeToolAsync('web_search', { query: q }).catch(e => ({ error: e.message }))
    ));
    const byUrl = new Map();
    for (const res of settled) {
        for (const r of (res?.results || [])) {
            if (!r.url || visited.has(r.url)) continue;
            const cur = byUrl.get(r.url);
            if (cur) cur.hits++;
            else byUrl.set(r.url, { title: r.title || '', url: r.url, snippet: (r.snippet || r.summary || '').slice(0, 300), hits: 1 });
        }
    }
    return [...byUrl.values()].sort((a, b) => b.hits - a.hits);
}

// Extract only passages of `text` relevant to `goal`. Long text is chunked; each chunk is one
// small bounded LLM call. Returns '' when nothing relevant is found. Shared by the deep-research
// per-page extractor and the fetch_url extraction option (keeps raw bytes out of agent context).
export async function extractRelevant(goal: any, text: any, sourceLabel: string | undefined = '', { maxChunks = _DR_CHUNKS_PER_PAGE, label = 'extract' }: { maxChunks?: number | undefined; label?: string | undefined; } | undefined = {}): Promise<any> {
    if (typeof text !== 'string' || text.length < 200) return '';
    const chunks = [];
    for (let i = 0; i < text.length && chunks.length < maxChunks; i += _DR_EXTRACT_CHUNK)
        chunks.push(text.slice(i, i + _DR_EXTRACT_CHUNK));

    const parts = await Promise.all(chunks.map(chunk =>
        callLLMComplete(
`Extract ONLY passages relevant to this goal. Output the extracted text directly — no reasoning, no preamble, no analysis. Quote or tightly paraphrase; keep concrete facts, numbers, dates, names, code. If nothing is relevant, reply with exactly: NOTHING

**Goal:** ${goal}
${sourceLabel ? `**Source:** ${sourceLabel}\n` : ''}
${chunk}`,
            // temperature: 0.1 — passage extraction is deterministic (quote or say NOTHING).
            { temperature: 0.1, maxTokens: 1024, label }
        ).catch(() => '')
    ));
    return parts.filter(p => p && !/^\s*NOTHING\s*$/.test(p.trim())).join('\n').trim();
}

// Fetch one page and extract passages relevant to the question. Returns '' when nothing useful.
async function _drExtractPage(question, page) {
    let res: Record<string, any> | undefined;
    try { res = await executeToolAsync('fetch_url', { url: page.url }); } catch { return ''; }
    const text = typeof res?.content === 'string' ? res.content : '';
    if (res?.error) return '';
    return extractRelevant(question, text, page.url, { label: 'research:extract' });
}

// Integrate this round's findings into the evolving report. The model appends a GAPS
// line that drives the next round's queries — "GAPS: none" ends the loop early.
async function _drSynthesize(state, findings) {
    const prompt = `${_drDateContext()}

You are updating an evolving research report.

**Original question:** ${state.question}
${state.plan?.success_criteria ? `**Success criteria:** ${state.plan.success_criteria}` : ''}

**Current report:**
${state.report || '(empty — first round)'}

**New findings from round ${state.round}:**
${findings.slice(0, _DR_FINDINGS_MAX)}

Integrate the new findings into the report. Remove redundancy, resolve contradictions, keep source URLs as inline citations. Keep the report under ${Math.round(_DR_REPORT_MAX_CHARS / 4)} tokens.

End your response with ONE line, after the report:
GAPS: <comma-separated open questions the report still cannot answer, or "none" if coverage is sufficient>

Write only the updated report followed by the GAPS line — no preamble.`;
    const resp = await callLLMComplete(prompt, { maxTokens: 8192, label: 'research:synthesize' });
    if (!resp?.trim()) return false;
    const gapsMatch = resp.match(/^GAPS:\s*(.+)$/im);
    state.gaps   = gapsMatch ? gapsMatch[1].trim() : '';
    state.report = resp.replace(/^GAPS:.*$/im, '').trim().slice(0, _DR_REPORT_MAX_CHARS);
    // Three-band done detection. The old exact match /^none/ ran an extra
    // iteration on "No significant gaps remain." and on a missing GAPS line ('').
    if (/^none\.?$/i.test(state.gaps)) return true;                        // definitely done
    if (typeof validateOutput === 'function') {
        const _vc = await validateOutput(
            state.gaps || '(the report did not include a GAPS line)', _DR_GAPS_CHECKS,
            { llm: typeof callLLMComplete === 'function' ? callLLMComplete : null });
        return !_vc;                                                       // fires → open questions remain
    }
    return false;                                                          // engine unavailable → old behavior
}

// Fires when research must continue (open questions remain). Pass band = explicit
// coverage-sufficient phrasing; fail band = a question list; middle → LLM.
const _DR_GAPS_CHECKS = [{
    name: 'coverage_insufficient',
    re_fail: (t: string) => /\?/.test(t) || t.split(',').length >= 2,
    re_pass: (t: string) => /\b(none|no (?:significant |major |open |remaining )?(?:gaps?|questions?)|sufficient|fully covered)\b/i.test(t),
    llmPrompt: 'A research loop must decide whether to run another iteration. The text below is the GAPS declaration from the latest report synthesis. Does it indicate that open questions remain and research must continue?',
}];

// Entry point — executed as the deep_research tool.
export async function runDeepResearch(question: any, { max_rounds = _DR_MAX_ROUNDS }: { max_rounds?: number | undefined; } | undefined = {}): Promise<any> {
    question = (question || '').trim();
    if (!question) return { error: 'deep_research: question is required' };
    const maxRounds = Math.min(Math.max(1, Number(max_rounds) || _DR_MAX_ROUNDS), 6);
    const _step = msg => activePlaceholder?.addSystemStep?.(msg);

    const state: any = {
        question, plan: null, report: '', gaps: '', round: 0,
        pastQueries: new Set(), visited: new Set(), sources: [],
    };

    _step(`→ Research: planning "${question.slice(0, 60)}"`);
    state.plan = await _drPlan(question);

    for (state.round = 1; state.round <= maxRounds; state.round++) {
        if (softStopPending) break;

        const queries = await _drQueries(state);
        if (!queries.length) break;
        queries.forEach(q => state.pastQueries.add(q));
        _step(`→ Research round ${state.round}/${maxRounds}: ${queries.map(q => `"${q.slice(0, 40)}"`).join(', ')}`);

        const results = await _drSearch(queries, state.visited);
        if (!results.length) { _step(`→ Research round ${state.round}: no new results`); break; }

        const pages = results.slice(0, _DR_PAGES_PER_ROUND);
        pages.forEach(p => state.visited.add(p.url));
        _step(`→ Research round ${state.round}: reading ${pages.length} sources`);
        const extracts = await Promise.all(pages.map(p => _drExtractPage(question, p)));

        const findingParts = [];
        for (let i = 0; i < pages.length; i++) {
            if (extracts[i]) {
                findingParts.push(`### ${pages[i].title || pages[i].url}\nSource: ${pages[i].url}\n${extracts[i]}`);
                state.sources.push(pages[i].url);
            }
        }
        // Keep search snippets as fallback signal when page extraction came up empty
        const snippetBlock = results.slice(0, 8)
            .map(r => `- ${r.title} (${r.url}): ${r.snippet}`).join('\n');
        const findings = (findingParts.join('\n\n') || '(no page content extracted this round)')
            + `\n\n### Search result snippets\n${snippetBlock}`;

        const done = await _drSynthesize(state, findings);
        if (done) { _step(`→ Research: coverage sufficient after round ${state.round}`); break; }
        if (state.round < maxRounds && state.gaps) _step(`→ Research gaps: ${state.gaps.slice(0, 100)}`);
    }

    if (!state.report) return { error: 'deep_research: no report could be produced (searches failed or returned nothing)' };

    // Persist to research/ so future sessions (researcher memory mining) can reuse it
    const slug = question.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
    const path = `research/${new Date().toISOString().slice(0, 10)}-${slug}.md`;
    try {
        await agentWriteFile(path,
            `# ${question}\n*Deep research, ${new Date().toISOString().slice(0, 16).replace('T', ' ')} — ${state.round} round(s), ${state.sources.length} sources*\n\n${state.report}\n`);
    } catch {}

    return {
        report: state.report,
        saved_to: path,
        rounds: state.round,
        sources: [...new Set(state.sources)],
        note: 'Present this report to the user (verbatim or lightly trimmed). It is already saved to the workspace — do not rewrite it to a file.',
    };
}

// Window bridge for classic scripts.
Object.assign(window, { extractRelevant, runDeepResearch });
