// exec-output.ts — shaping execute_code output before the model sees it (headless runner).
// Pure functions; no DOM, no state.

// curl's progress meter goes to stderr unless -s is given: a two-line header plus one
// \r-separated row per update. It carries nothing the model uses and cost ~300 chars per call
// (v0.56: 452 results, 344 in TheAgentCompany). Rows can run straight into -v output with no
// newline, so rows are removed inline, not as whole lines.
const _CURL_HEADER_RE = /^ *% Total +% Received % Xferd +Average Speed +Time +Time +Time +Current\r?\n +Dload +Upload +Total +Spent +Left +Speed\r?\n/gm;
const _N = '[\\d.]+[kMGTP]?';
const _T = '[-:\\d]{7,8}';
const _CURL_ROW_RE = new RegExp(`\\r? *\\d{1,3} +${_N} +\\d{1,3} +${_N} +\\d{1,3} +${_N} +${_N} +${_N} +${_T} +${_T} +${_T} +${_N}`, 'g');

export function stripCurlProgress(stderr: string): string {
    if (!stderr || !stderr.includes('% Total')) return stderr;
    const out = stderr.replace(_CURL_HEADER_RE, '').replace(_CURL_ROW_RE, '');
    return out.trim() ? out.replace(/^\n+/, '') : '';
}

// Long output keeps its head and its tail. Tail-only clipping lost what programs print first
// (column names, first rows, the first error) — v0.56 clipped 742 results that way; TerminalBench
// count-dataset-tokens lost its own diagnostic prints and re-ran the script 20 times.
export const CLIP_HEAD = 2_000, CLIP_TAIL = 3_000;

// A streamed buffer that never exceeds `max` chars: overflow is dropped from the middle, so the
// head survives for clipOutput. `dropped` counts what was already discarded.
export type OutBuf = { text: string; dropped: number };
export function appendOut(buf: OutBuf, chunk: string, max: number): void {
    buf.text += chunk;
    if (buf.text.length > max) {
        const cut = buf.text.length - max;
        buf.text = buf.text.slice(0, CLIP_HEAD) + buf.text.slice(CLIP_HEAD + cut);
        buf.dropped += cut;
    }
}

export function clipOutput(s: string, alreadyDropped = 0, head = CLIP_HEAD, tail = CLIP_TAIL): string {
    if (!s || (s.length <= head + tail && !alreadyDropped)) return s;
    const keepTail = Math.min(tail, Math.max(0, s.length - head));
    const dropped = s.length - head - keepTail + alreadyDropped;
    return `${s.slice(0, head)}\n…[${dropped} chars omitted — redirect to a file and grep/head/tail it to see more]…\n${s.slice(s.length - keepTail)}`;
}
