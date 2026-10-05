/**
 * shell-singleton.ts — Lazy-initialized Shell backed by FreeGent workspace
 *
 * Provides a single Shell instance per page load. The shell is initialized on
 * first use (lazy) so WASM packages are not fetched until actually needed.
 *
 * Usage:
 *   import { getShell } from './shiro/shell-singleton';
 *   const shell = await getShell();
 *   const result = await shell.execute('ls /workspace');
 */

import { Shell } from './shell';
import { CommandRegistry, COMMAND_CATALOG } from './commands/index';
import { FWFileSystem, WORKSPACE_MOUNT } from './fg-filesystem';

let _shell: Shell | null = null;
let _initPromise: Promise<Shell> | null = null;
let _generation = 0;

async function createShell(): Promise<Shell> {
    const commands = new CommandRegistry();
    commands.registerAll(COMMAND_CATALOG);

    // Create FreeGent-backed filesystem
    const fs = new FWFileSystem();
    await fs.init();

    // Create shell; set CWD to workspace root
    const shell = new Shell(fs, commands);
    shell.cwd = WORKSPACE_MOUNT;
    // Sync env['PWD'] so the shell doesn't revert cwd to '/home/user'
    // after the first command (shell.ts line: this.cwd = this.env['PWD'] || this.cwd)
    shell.env['PWD'] = WORKSPACE_MOUNT;

    return shell;
}

/**
 * Get the singleton Shell, initializing it on first call.
 * Subsequent calls return the cached instance immediately.
 */
export async function getShell(): Promise<Shell> {
    if (_shell) return _shell;
    if (_initPromise) return _initPromise;

    const generation = _generation;
    const pending = createShell().then(s => {
        if (_generation === generation) _shell = s;
        return s;
    }).finally(() => { if (_initPromise === pending) _initPromise = null; });
    _initPromise = pending;
    return _initPromise;
}

/**
 * A new shell on the singleton's filesystem and commands, starting in /workspace — for a run
 * that should start fresh, like a new bash process: no variables, functions, aliases, options or
 * traps from earlier runs. Files (the workspace, /tmp, folders made with mkdir) are shared.
 */
export async function newShell(): Promise<Shell> {
    const base = await getShell();
    const shell = new Shell(base.fs, base.commands);
    shell.cwd = WORKSPACE_MOUNT;
    shell.env['PWD'] = WORKSPACE_MOUNT;
    return shell;
}

/**
 * Reset the singleton (e.g. after a workspace switch).
 * The next call to getShell() creates a fresh instance.
 */
export function resetShell(): void {
    _generation++;
    _shell = null;
    _initPromise = null;
}
