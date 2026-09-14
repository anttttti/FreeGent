// fg-service-worker.ts — Service Worker for FreeGent API key injection.
//
// Implements Phase 5 Security Fix 1: keep API keys off the main-thread page script.
//
// Architecture:
//   Main page → stores keys in IDB accessible ONLY to this SW.
//   Main page → calls LLM APIs with no Authorization header.
//   This SW    → intercepts those fetches and injects the header from IDB.
//   Page scripts never see the raw key value in JS memory.
//
// This eliminates the XSS/generated-code key exfiltration vector that exists when
// keys are read from localStorage and passed in fetch() headers by the page.
//
// Registration (init.ts, Phase 5):
//   const reg = await navigator.serviceWorker.register('/fg-service-worker.js');
//   // Send key to SW via postMessage (key goes into SW's IDB, not the page):
//   reg.active?.postMessage({ type: 'SET_KEY', provider: 'openai', key: 'sk-...' });
//
// Intercepted URLs (configurable — see INTERCEPTED_ORIGINS):
//   https://api.openai.com/*
//   https://openrouter.ai/*
//   https://api.anthropic.com/*
//   https://api.groq.com/*
//   https://api.mistral.ai/*
//   … (extend as providers are added)
//
// Phase 5 target — see agentharness_migration_v2.md Phase 5, §E CORS proxy fix.
//
// NOTE: This file is the main-thread controller and type definitions.
//       The actual Service Worker script is in public/fg-sw.js (separate file
//       to satisfy the "SW must be served from the scope root" requirement).
//       This module provides the registration API and message helpers.

// ── URL patterns intercepted by the Service Worker ───────────────────────────

export const INTERCEPTED_ORIGINS: ReadonlyArray<string> = [
    'https://api.openai.com',
    'https://openrouter.ai',
    'https://api.anthropic.com',
    'https://api.groq.com',
    'https://api.mistral.ai',
    'https://api.cerebras.ai',
    'https://integrate.api.nvidia.com',
    'https://generativelanguage.googleapis.com',
    'https://opencode.ai',
    'https://tokenharbor.ai',
];

// ── Message protocol (main thread ↔ Service Worker) ──────────────────────────

export type SWMessage =
    | { type: 'SET_KEY';    provider: string; key: string }
    | { type: 'DELETE_KEY'; provider: string }
    | { type: 'CLEAR_KEYS' }
    | { type: 'PING' };

export type SWResponse =
    | { type: 'PONG' }
    | { type: 'ACK' }
    | { type: 'ERROR'; message: string };

// ── Registration helper ───────────────────────────────────────────────────────

/**
 * Register the FW Service Worker and return a controller.
 * Call from init.ts during startup.
 *
 * @param swUrl - URL of the SW script. Default: '/fg-sw.js'.
 */
export async function registerFWServiceWorker(
    swUrl = '/fg-sw.js',
): Promise<FWServiceWorkerController | null> {
    if (!('serviceWorker' in navigator)) {
        console.warn('[FW SW] Service Workers not supported in this environment.');
        return null;
    }

    try {
        const reg = await navigator.serviceWorker.register(swUrl, { scope: '/' });
        await navigator.serviceWorker.ready;
        return new FWServiceWorkerController(reg);
    } catch (err) {
        console.error('[FW SW] Registration failed:', err);
        return null;
    }
}

// ── Controller ────────────────────────────────────────────────────────────────

/**
 * Typed controller for sending messages to the FW Service Worker.
 */
export class FWServiceWorkerController {
    constructor(private readonly reg: ServiceWorkerRegistration) {}

    /**
     * Store a provider API key in the SW's IDB (not in the main-thread JS heap).
     * The SW will inject it as an Authorization header on matching fetches.
     *
     * @param provider - Provider name, e.g. 'openai', 'openrouter', 'anthropic'.
     * @param key      - API key string.
     */
    async setKey(provider: string, key: string): Promise<void> {
        return this._send({ type: 'SET_KEY', provider, key });
    }

    /**
     * Remove a provider key from the SW's IDB.
     */
    async deleteKey(provider: string): Promise<void> {
        return this._send({ type: 'DELETE_KEY', provider });
    }

    /**
     * Remove all provider keys from the SW's IDB.
     */
    async clearKeys(): Promise<void> {
        return this._send({ type: 'CLEAR_KEYS' });
    }

    /**
     * Ping the SW — resolves when the SW responds. Use to verify SW is active.
     */
    async ping(): Promise<void> {
        return this._send({ type: 'PING' });
    }

    /** Unregister the Service Worker entirely. */
    async unregister(): Promise<boolean> {
        return this.reg.unregister();
    }

    private _send(msg: SWMessage): Promise<void> {
        return new Promise((resolve, reject) => {
            const sw = this.reg.active;
            if (!sw) { reject(new Error('SW not active')); return; }

            const { port1, port2 } = new MessageChannel();
            port1.onmessage = (evt) => {
                const resp = evt.data as SWResponse;
                if (resp.type === 'ERROR') reject(new Error(resp.message));
                else resolve();
                port1.close();
            };
            sw.postMessage(msg, [port2]);
        });
    }
}

// ── Provider → base URL mapping ───────────────────────────────────────────────
// Used by the SW (public/fg-sw.js) to match keys to outgoing requests.

export const PROVIDER_BASE_URL_MAP: Record<string, string> = {
    openai:      'https://api.openai.com',
    openrouter:  'https://openrouter.ai',
    anthropic:   'https://api.anthropic.com',
    groq:        'https://api.groq.com',
    mistral:     'https://api.mistral.ai',
    cerebras:    'https://api.cerebras.ai',
    nvidia:      'https://integrate.api.nvidia.com',
    google:      'https://generativelanguage.googleapis.com',
    opencode:    'https://opencode.ai',
    tokenharbor: 'https://tokenharbor.ai',
};
