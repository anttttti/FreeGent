/**
 * kill - send a signal to a process in shiro's process table.
 * (The `trap` builtin lives in shell.ts.)
 */
import type { Command } from './index';
import { parseArgs } from './flags';

export const kill: Command = {
  name: "kill",
  description: "Send signal to process",
  async exec(ctx) {
    const args = ctx.args;
    const { flags, values, positional } = parseArgs(args, ["s"]);

    // -l: list signals
    if (flags.l || flags.L) {
      const signals = [
        "HUP", "INT", "QUIT", "ILL", "TRAP", "ABRT", "BUS", "FPE",
        "KILL", "USR1", "SEGV", "USR2", "PIPE", "ALRM", "TERM", "STKFLT",
        "CHLD", "CONT", "STOP", "TSTP", "TTIN", "TTOU", "URG", "XCPU",
        "XFSZ", "VTALRM", "PROF", "WINCH", "IO", "PWR", "SYS"
      ];

      if (flags.L) {
        ctx.stdout += signals.map((sig, i) => `${i + 1}) SIG${sig}`).join("\n") + "\n";
        return 0;
      } else {
        ctx.stdout += signals.join(" ") + "\n";
        return 0;
      }
    }

    const signal = values.s || "TERM";

    if (positional.length === 0) {
      ctx.stderr += "kill: usage: kill [-s SIGNAL] PID...\n";
      return 1;
    }

    const { processTable } = await import('../process-table');
    const shell = ctx.shell;
    let anyFailed = false;

    for (const pidStr of positional) {
      // %N targets background job N in the shell
      if (pidStr.startsWith('%')) {
        const jobId = parseInt(pidStr.slice(1), 10);
        const job = shell.backgroundJobs.get(jobId);
        if (job && job.status === 'running') {
          if (job.abortController) job.abortController.abort();
          job.status = 'failed';
          job.exitCode = 130;
        } else {
          ctx.stderr += `kill: %${jobId}: no such job\n`;
          anyFailed = true;
        }
        continue;
      }

      const pid = parseInt(pidStr, 10);
      if (isNaN(pid)) {
        ctx.stderr += `kill: ${pidStr}: invalid pid\n`;
        anyFailed = true;
        continue;
      }

      // Try process table first (windowed processes)
      if (processTable.kill(pid)) continue;

      // Try shell background jobs (by job ID matching PID)
      let found = false;
      for (const [id, job] of shell.backgroundJobs) {
        if (id === pid && job.status === 'running') {
          if (job.abortController) job.abortController.abort();
          job.status = 'failed';
          job.exitCode = 130;
          found = true;
          break;
        }
      }
      if (found) continue;

      ctx.stderr += `kill: (${pid}) - No such process\n`;
      anyFailed = true;
    }

    return anyFailed ? 1 : 0;
  },
};
