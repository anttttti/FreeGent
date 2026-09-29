// static-hosts.ts — hosts that serve FreeGent as static files with no local /api/proxy server.
// On these, proxied calls go through the default CF Worker (config.ts DEFAULT_CF_WORKER), and
// cf-worker/worker.js ALLOWED_ORIGINS must list each of them.

const STATIC_HOSTS = new Set(['freegent.ai', 'www.freegent.ai']);

export function isStaticHost(host: string): boolean {
    return STATIC_HOSTS.has(host) || host.endsWith('.github.io') || host.endsWith('.pages.dev');
}
