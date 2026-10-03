
import type { Command } from './index';
import { parseArgs } from './flags';
export const sleep: Command = {
  name: "sleep",
  description: "Delay for a specified amount of time",
  async exec(ctx) {
    const args = ctx.args;
    const { positional } = parseArgs(args);

    if (positional.length === 0) {
      ctx.stderr += "sleep: missing operand\n";
      return 1;
    }

    const input = positional[0];
    let seconds = 0;

    // Parse duration: supports s (seconds), m (minutes), h (hours), d (days)
    const match = input.match(/^(\d+(?:\.\d+)?)(s|m|h|d)?$/);

    if (!match) {
      ctx.stderr += `sleep: invalid time interval '${input}'\n`;
      return 1;
    }

    const value = parseFloat(match[1]);
    const unit = match[2] || "s";

    switch (unit) {
      case "s":
        seconds = value;
        break;
      case "m":
        seconds = value * 60;
        break;
      case "h":
        seconds = value * 3600;
        break;
      case "d":
        seconds = value * 86400;
        break;
    }

    // In browser environment, we simulate sleep with a promise
    // Note: This is non-blocking in async context
    // Wakes early (status 130) when Ctrl+C is pressed or an enclosing `timeout` expires
    const signal = ctx.shell?.abortSignal?.();
    if (signal?.aborted) return 130;
    let aborted = false;
    await new Promise<void>(resolve => {
      const timer = (globalThis as any).setTimeout(() => resolve(), seconds * 1000);
      signal?.addEventListener('abort', () => { aborted = true; (globalThis as any).clearTimeout(timer); resolve(); }, { once: true });
    });

    return aborted ? 130 : 0;
  },
};
