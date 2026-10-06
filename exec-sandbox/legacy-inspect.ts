// Small formatter for engines that cannot load node-inspect-extracted's regexes.
// Modern engines replace it with the full formatter after the trusted JS bundle loads.
const modern = () => (globalThis as any).__fgModernInspect;
export function inspect(value: any, opts: any = {}): string {
    if (modern()) return modern().inspect(value, opts);
    const seen = new Set();
    const show = (v: any, depth: number): string => {
        if (typeof v === 'string') return "'" + v.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n') + "'";
        if (typeof v === 'bigint') return String(v) + 'n';
        if (v === null || typeof v !== 'object') return String(v);
        if (v instanceof Error) return v.name + ': ' + v.message;
        if (v instanceof Date || v instanceof RegExp) return String(v);
        if (seen.has(v)) return '[Circular]';
        if (depth < 0) return Array.isArray(v) ? '[Array]' : '[Object]';
        seen.add(v);
        const result = Array.isArray(v) ? '[ ' + v.map(x => show(x, depth - 1)).join(', ') + ' ]'
            : '{ ' + Object.keys(v).map(k => {
                const d = Object.getOwnPropertyDescriptor(v, k);
                return (/^[a-zA-Z_$][\w$]*$/.test(k) ? k : show(k, 0)) + ': ' + (d?.get ? '[Getter]' : show(v[k], depth - 1));
            }).join(', ') + ' }';
        seen.delete(v);
        return result;
    };
    return show(value, opts.depth ?? 2);
}
export function format(first?: any, ...values: any[]): string {
    if (modern()) return modern().format(first, ...values);
    if (arguments.length === 0) return '';
    const display = (v: any) => typeof v === 'string' ? v : inspect(v);
    if (typeof first !== 'string') return [first, ...values].map(display).join(' ');
    let index = 0;
    const text = first.replace(/%[%sdifjoOc]/g, token => {
        if (token === '%%') return '%';
        if (index >= values.length) return token;
        const v = values[index++];
        if (token === '%c') return '';
        if (token === '%s') return String(v);
        if (token === '%d') return String(Number(v));
        if (token === '%i') return String(parseInt(v, 10));
        if (token === '%f') return String(parseFloat(v));
        if (token === '%j') { try { return JSON.stringify(v); } catch { return '[Circular]'; } }
        return inspect(v);
    });
    return [text, ...values.slice(index).map(display)].join(' ');
}
export const getStringWidth = (s: string) => Array.from(s).length;
