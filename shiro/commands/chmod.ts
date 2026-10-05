
/**
 * Parse a symbolic mode string like "+x", "u+rw", "go-w", "a=rx" or comma-separated "u+x,g+r".
 * Returns the new mode given the current mode, or null if invalid.
 */
import type { Command } from './index';
import { parseArgs, readdirEntries, statEntry } from './flags';
import { applySymbolicMode } from '../utils/permissions';

export const chmod: Command = {
  name: "chmod",
  description: "Change file mode bits",
  async exec(ctx) {
    const args = ctx.args;
    // Custom arg parsing: chmod [-R] MODE FILE...
    // MODE can start with +, -, or be octal/symbolic. Can't use generic parseArgs
    // because -x, +x etc. look like flags but are actually mode strings.
    let recursive = false;
    let modeStr = '';
    const targets: string[] = [];

    for (let i = 0; i < args.length; i++) {
      const arg = args[i];
      if (arg === '-R' || arg === '--recursive') {
        recursive = true;
      } else if (!modeStr) {
        // First non-flag argument is the mode
        modeStr = arg;
      } else {
        targets.push(arg);
      }
    }

    if (!modeStr || targets.length === 0) {
      ctx.stderr += "chmod: missing operand\n";
      return 1;
    }

    async function chmodPath(path: string, mode: number): Promise<void> {
      const resolved = ctx.fs.resolvePath(path, ctx.cwd);
      try { await ctx.fs.chmod(resolved, mode); }
      catch(error:any) { if (error.code === 'ENOENT') throw new Error(`cannot access '${path}': No such file or directory`); throw error; }
      if (recursive) {
        try {
          const stat = await statEntry(ctx.fs, resolved);
          if (stat.type === "dir") {
            const entries = await readdirEntries(ctx.fs, resolved);
            for (const entry of entries) {
              await chmodPath(resolved + "/" + entry.name, mode);
            }
          }
        } catch { /* ignore */ }
      }
    }

    try {
      // Try octal mode first
      if (/^[0-7]+$/.test(modeStr)) {
        const octalMode = parseInt(modeStr, 8);
        for (const t of targets) {
          await chmodPath(t, octalMode);
        }
        return 0;
      }

      // Try symbolic mode
      for (const t of targets) {
        const resolved = ctx.fs.resolvePath(t, ctx.cwd);
        let currentMode = 0o644;
        try {
          const stat = await statEntry(ctx.fs, resolved);
          currentMode = stat.mode;
        } catch { /* use default */ }
        const newMode = applySymbolicMode(modeStr, currentMode,{directory:(await ctx.fs.stat(resolved)).isDirectory(),umask:ctx.shell.umask});
        if (newMode === null) {
          ctx.stderr += `chmod: invalid mode: '${modeStr}'\n`;
          return 1;
        }
        await chmodPath(t, newMode);
      }
      return 0;
    } catch (e: unknown) {
      ctx.stderr += `chmod: ${e instanceof Error ? e.message : e}\n`;
      return 1;
    }
  },
};
