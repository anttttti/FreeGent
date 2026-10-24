// native-running.ts — the commands running natively right now, each with the function that ends it. Pure (no Node imports): the executor registers its
// commands here and the Stop path, which also runs in the browser bundle, ends them (codex R81).
const _running = new Set<() => void>();
/** Register a running command; the returned function unregisters it when it has ended. */
export function registerNativeRun(kill: () => void): () => void { _running.add(kill); return () => { _running.delete(kill); }; }
/** End every command that is running; returns how many there were. */
export function killRunningNative(): number { const n = _running.size; for (const k of [..._running]) { try { k(); } catch {} } return n; }
