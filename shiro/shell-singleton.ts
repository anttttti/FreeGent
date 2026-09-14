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
import { CommandRegistry } from './commands/index';
import { unixCommands } from './commands/unix';
import { shellBuiltins } from './commands/shell-builtins';
import { shiroCmds } from './commands/shiro-cmds';
import { grepCmd } from './commands/grep';
import { sedCmd } from './commands/sed';
import { globCmd } from './commands/glob';
import { jsEvalCmd } from './commands/jseval';
import { nodeCmd } from './commands/jseval/node-cmd';
import { FWFileSystem, WORKSPACE_MOUNT } from './fg-filesystem';

let _shell: Shell | null = null;
let _initPromise: Promise<Shell> | null = null;

async function createShell(): Promise<Shell> {
    // Build command registry
    const commands = new CommandRegistry();
    commands.registerAll(unixCommands);
    commands.registerAll(shellBuiltins);
    commands.registerAll(shiroCmds);
    // Individual commands registered with priority (override builtins)
    commands.registerAll([grepCmd, sedCmd, globCmd, jsEvalCmd, nodeCmd]);

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

    _initPromise = createShell().then(s => {
        _shell = s;
        _initPromise = null;
        return s;
    });
    return _initPromise;
}

/**
 * Reset the singleton (e.g. after a workspace switch).
 * The next call to getShell() creates a fresh instance.
 */
export function resetShell(): void {
    _shell = null;
    _initPromise = null;
}
