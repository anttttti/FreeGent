// shiro/utils/archive-path.ts — an archive member's name as a path inside the extraction directory.
//
// Each extractor had its own check, or none: npm's tarball extractor joined names as given (codex R273), the legacy tar format and tar's
// hardlink sources skipped tar's ".." check (R285, R286), and unzip passed "/x" on as absolute, outside its -d directory (R289).
// Leading slashes, "." and empty segments are dropped; a name with a ".." segment is refused (null).
export function memberPath(name: string): string | null {
    const parts = String(name).replace(/\\/g, '/').split('/').filter(p => p && p !== '.');
    if (!parts.length || parts.includes('..')) return null;
    return parts.join('/');
}
