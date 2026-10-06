// shiro/utils/glob-regex.ts — shell glob → RegExp for the commands that match names themselves (find, du, tar, zip).
// Backslash escapes the next character; [abc] / [!abc] are bracket classes. By default `*` and `?`
// match any character including `/` (tar, du, zip exclusion semantics, and find -name which sees a
// single path component); slashSpecial makes them stop at `/`. The whole name must match.

export function globToRegex(glob: string, { icase = false, slashSpecial = false }: { icase?: boolean; slashSpecial?: boolean } = {}): RegExp {
  const star = slashSpecial ? '[^/]*' : '[\\s\\S]*';
  const any = slashSpecial ? '[^/]' : '[\\s\\S]';
  let re = '^';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '\\' && i + 1 < glob.length) { re += glob[++i].replace(/[.*+?^${}()|[\]\\\/]/g, '\\$&'); continue; }
    if (c === '*') { re += star; continue; }
    if (c === '?') { re += any; continue; }
    if (c === '[') {
      const end = glob.indexOf(']', i + 2);
      if (end > 0) {
        let body = glob.slice(i + 1, end);
        if (body[0] === '!') body = '^' + body.slice(1);
        re += '[' + body.replace(/\\/g, '\\\\') + ']';
        i = end;
        continue;
      }
    }
    re += c.replace(/[.*+?^${}()|[\]\\\/]/g, '\\$&');
  }
  return new RegExp(re + '$', icase ? 'i' : '');
}
