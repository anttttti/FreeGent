// The two backends the tools run on, for tests that run the same calls on both:
//   browser  — the workspace in IndexedDB, execute_code in the exec sandbox (tests/fake-sandbox.ts)
//   headless — the workspace as a directory (NodeFsAdapter), execute_code as real bash, python3
//              and node processes in it (native-exec.ts), as headless-runner.ts sets them up
// Each test starts with an empty workspace.
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setupBrowserTools } from './fake-sandbox';
import { setWorkspaceAdapter } from '../workspace';
import { NodeFsAdapter } from '../node-fs-adapter';
import { createNativeExec } from '../native-exec';

const W = globalThis as any;

export type Backend = {
    name: 'browser' | 'headless';
    /** Before each test: an empty workspace and the backend's tools. */
    setup(): Promise<void>;
    teardown(): void;
    /** The workspace directory as the code sees it (cwd of execute_code). */
    root(): string;
    /** A workspace file's bytes, or null when there is none. */
    stored(name: string): Promise<Buffer | null>;
};

export const browser: Backend = {
    name: 'browser',
    setup: setupBrowserTools,
    teardown() {},
    root: () => '/workspace',
    async stored(name) {
        const rec = await W.readWorkspaceFile(name);
        if (!rec) return null;
        return rec.encoding === 'base64' ? Buffer.from(rec.content, 'base64') : Buffer.from(rec.content, 'utf8');
    },
};

let dir = '';
export const headless: Backend = {
    name: 'headless',
    async setup() {
        await setupBrowserTools();   // state the tools share (the IndexedDB stays unused)
        dir = mkdtempSync(join(tmpdir(), 'fg-headless-'));
        setWorkspaceAdapter(new NodeFsAdapter(dir) as any);
        W.nativeExec = createNativeExec({ workspaceRoot: dir });
    },
    teardown() {
        setWorkspaceAdapter(null);
        delete W.nativeExec;
        if (dir) rmSync(dir, { recursive: true, force: true });
    },
    root: () => dir,
    async stored(name) {
        const p = join(dir, name);
        return existsSync(p) ? readFileSync(p) : null;
    },
};

export const BACKENDS = [browser, headless];
