// shiro/utils/posix-path.ts — Node's POSIX basename / dirname / extname, for the `path` modules of the in-browser shell and of execute_code
// JavaScript. Both had their own versions that disagreed with Node on trailing separators, "." / ".." components and trailing dots
// (codex R191/R192: extname('foo.') was '', basename('a/') was '').

export function basename(p: string, suffix?: string): string {
    if (suffix !== undefined && suffix.length > 0 && suffix.length <= p.length) {
        // Node's suffix rule, as Node writes it: the suffix is matched backwards from the last non-separator character
        if (suffix === p) return '';
        let start = 0, end = -1, matchedSlash = true, extIdx = suffix.length - 1, firstNonSlashEnd = -1;
        for (let i = p.length - 1; i >= 0; --i) {
            if (p[i] === '/') { if (!matchedSlash) { start = i + 1; break; } continue; }
            if (firstNonSlashEnd === -1) { matchedSlash = false; firstNonSlashEnd = i + 1; }
            if (extIdx >= 0) {
                if (p[i] === suffix[extIdx]) { if (--extIdx === -1) end = i; }
                else { extIdx = -1; end = firstNonSlashEnd; }
            }
        }
        if (start === end) end = firstNonSlashEnd;
        else if (end === -1) end = p.length;
        return p.slice(start, end);
    }
    let end = p.length;
    while (end > 0 && p[end - 1] === '/') end--;
    if (end === 0) return '';
    return p.slice(p.lastIndexOf('/', end - 1) + 1, end);
}

export function dirname(p: string): string {
    if (p.length === 0) return '.';
    const hasRoot = p[0] === '/';
    let end = -1, matchedSlash = true;
    for (let i = p.length - 1; i >= 1; --i) {
        if (p[i] === '/') { if (!matchedSlash) { end = i; break; } }
        else matchedSlash = false;
    }
    if (end === -1) return hasRoot ? '/' : '.';
    if (hasRoot && end === 1) return '//';
    return p.slice(0, end);
}

export function extname(p: string): string {
    // Node's lib/path.js algorithm: ".env", ".." and a name with no dot have no extension; "foo." has "."
    let startDot = -1, startPart = 0, end = -1, matchedSlash = true, preDotState = 0;
    for (let i = p.length - 1; i >= 0; --i) {
        const c = p[i];
        if (c === '/') { if (!matchedSlash) { startPart = i + 1; break; } continue; }
        if (end === -1) { matchedSlash = false; end = i + 1; }
        if (c === '.') { if (startDot === -1) startDot = i; else if (preDotState !== 1) preDotState = 1; }
        else if (startDot !== -1) preDotState = -1;
    }
    if (startDot === -1 || end === -1 || preDotState === 0 || (preDotState === 1 && startDot === end - 1 && startDot === startPart + 1)) return '';
    return p.slice(startDot, end);
}
