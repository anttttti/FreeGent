
import type { Command } from './index';
import { cannotCreate, parseArgs, statEntry } from './flags';
import { parseDateString } from './date';
export const touch: Command = {
  name: "touch",
  description: "Change file timestamps or create empty files",
  async exec(ctx) {
    const args = ctx.args;
    const { positional, flags, values } = parseArgs(args,['t','d','r','date','reference','time']);

    if (positional.length === 0) {
      ctx.stderr += "touch: missing operand\n";
      return 1;
    }

    const noCreate = flags.c || flags['no-create'];
    const now = new Date();
    const utc = /^(UTC|GMT)(0)?$/.test(ctx.env.TZ ?? '');
    let atime = now, mtime = now;
    const reference = values.r ?? values.reference;
    if (reference !== undefined) {
      try { const st = await ctx.fs.stat(ctx.fs.resolvePath(reference,ctx.cwd)); atime = st.atime ?? st.mtime; mtime = st.mtime; }
      catch { ctx.stderr += `touch: failed to get attributes of '${reference}': No such file or directory\n`; return 1; }
    }
    const stamp = values.t;
    const date = values.d ?? values.date;
    if (stamp !== undefined || date !== undefined) {
      let parsed:Date|null = null;
      if (stamp !== undefined) {
        const match = /^(?:(\d{2})?(\d{2}))?(\d{2})(\d{2})(\d{2})(\d{2})(?:\.(\d{2}))?$/.exec(stamp);
        if (match) {
          const y = match[1] ? +(match[1]+match[2]) : match[2] ? +match[2] + (+match[2] < 69 ? 2000 : 1900) : (utc ? now.getUTCFullYear() : now.getFullYear());
          const mo = +match[3]-1, d = +match[4], h = +match[5], mi = +match[6], s = +(match[7] ?? 0);
          const candidate = utc ? new Date(Date.UTC(y,mo,d,h,mi,s)) : new Date(y,mo,d,h,mi,s);
          if (mo < 12 && d > 0 && h < 24 && mi < 60 && s < 60 && (utc ? candidate.getUTCDate() : candidate.getDate()) === d) parsed = candidate;
        }
      } else parsed = parseDateString(date!,now,utc);
      if (!parsed || !Number.isFinite(parsed.getTime())) {ctx.stderr += `touch: invalid date format '${stamp ?? date}'\n`; return 1;}
      atime = mtime = parsed;
    }
    let status = 0;

      for (const p of positional) {
        try {
        const resolved = ctx.fs.resolvePath(p, ctx.cwd);

        let exists = false;
        try {
          await statEntry(ctx.fs, resolved);
          exists = true;
        } catch {
          exists = false;
        }

        if (!exists) {
          if (noCreate) {
            // -c flag: don't create file
            continue;
          }
          // Create empty file
          const why = await cannotCreate(ctx.fs, resolved);
          if (why) throw new Error(`cannot touch '${p}': ${why}`);
          await ctx.fs.writeFile(resolved, "");
        }
        const st = await ctx.fs.stat(resolved);
        const accessOnly = flags.a || values.time === 'access' || values.time === 'atime' || values.time === 'use';
        const modifyOnly = flags.m || values.time === 'modify' || values.time === 'mtime';
        await ctx.fs.utimes(resolved, modifyOnly && !accessOnly ? st.atime ?? st.mtime : atime, accessOnly && !modifyOnly ? st.mtime : mtime);
        } catch (e:unknown) {ctx.stderr += `touch: ${e instanceof Error ? e.message : e}\n`; status = 1;}
      }
      return status;
  },
};
