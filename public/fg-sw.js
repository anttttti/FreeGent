/**
 * fg-sw.js — FreeGent Service Worker (key injection).
 *
 * Place at the web root so it has scope '/'.
 * Registered by fg-service-worker.ts → registerFWServiceWorker().
 *
 * Responsibilities:
 *   1. Store API keys in IndexedDB (never in the main-thread JS heap).
 *   2. Intercept fetch requests to LLM provider origins.
 *   3. Inject the correct Authorization header from IDB before forwarding.
 *
 * Message protocol (from fg-service-worker.ts):
 *   SET_KEY    { provider, key } → store key in IDB
 *   DELETE_KEY { provider }      → remove key from IDB
 *   CLEAR_KEYS                   → remove all keys from IDB
 *   PING                         → respond with PONG
 *
 * Phase 5 — see agentharness_migration_v2.md §E CORS proxy fix.
 */

'use strict';

// ── IDB key store ─────────────────────────────────────────────────────────────

const DB_NAME    = 'fg-sw-keys';
const DB_VERSION = 1;
const STORE_NAME = 'keys';

/** @type {IDBDatabase | null} */
let _db = null;

async function _openDb() {
    if (_db) return _db;
    return new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, DB_VERSION);
        req.onupgradeneeded = () => {
            req.result.createObjectStore(STORE_NAME);
        };
        req.onsuccess = () => { _db = req.result; resolve(_db); };
        req.onerror   = () => reject(req.error);
    });
}

async function _getKey(provider) {
    const db = await _openDb();
    return new Promise((resolve, reject) => {
        const tx  = db.transaction(STORE_NAME, 'readonly');
        const req = tx.objectStore(STORE_NAME).get(provider);
        req.onsuccess = () => resolve(req.result);
        req.onerror   = () => reject(req.error);
    });
}

async function _setKey(provider, key) {
    const db = await _openDb();
    return new Promise((resolve, reject) => {
        const tx  = db.transaction(STORE_NAME, 'readwrite');
        const req = tx.objectStore(STORE_NAME).put(key, provider);
        req.onsuccess = () => resolve();
        req.onerror   = () => reject(req.error);
    });
}

async function _deleteKey(provider) {
    const db = await _openDb();
    return new Promise((resolve, reject) => {
        const tx  = db.transaction(STORE_NAME, 'readwrite');
        const req = tx.objectStore(STORE_NAME).delete(provider);
        req.onsuccess = () => resolve();
        req.onerror   = () => reject(req.error);
    });
}

async function _clearKeys() {
    const db = await _openDb();
    return new Promise((resolve, reject) => {
        const tx  = db.transaction(STORE_NAME, 'readwrite');
        const req = tx.objectStore(STORE_NAME).clear();
        req.onsuccess = () => resolve();
        req.onerror   = () => reject(req.error);
    });
}

// ── Provider URL → provider name mapping ──────────────────────────────────────

const ORIGIN_TO_PROVIDER = new Map([
    ['https://api.openai.com',                      'openai'],
    ['https://openrouter.ai',                       'openrouter'],
    ['https://api.anthropic.com',                   'anthropic'],
    ['https://api.groq.com',                        'groq'],
    ['https://api.mistral.ai',                      'mistral'],
    ['https://api.cerebras.ai',                     'cerebras'],
    ['https://integrate.api.nvidia.com',            'nvidia'],
    ['https://generativelanguage.googleapis.com',   'google'],
    ['https://opencode.ai',                         'opencode'],
    ['https://tokenharbor.ai',                      'tokenharbor'],
]);

function _providerForUrl(url) {
    try {
        const origin = new URL(url).origin;
        return ORIGIN_TO_PROVIDER.get(origin) ?? null;
    } catch {
        return null;
    }
}

// ── Lifecycle ─────────────────────────────────────────────────────────────────

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (evt) => evt.waitUntil(self.clients.claim()));

// ── Message handler (SET_KEY / DELETE_KEY / CLEAR_KEYS / PING) ───────────────

self.addEventListener('message', (evt) => {
    const msg  = evt.data;
    const port = evt.ports[0];
    if (!port) return;

    const respond = (resp) => port.postMessage(resp);
    const respondErr = (msg) => port.postMessage({ type: 'ERROR', message: msg });

    if (!msg?.type) { respondErr('Missing message type'); return; }

    switch (msg.type) {
        case 'PING':
            respond({ type: 'PONG' });
            break;

        case 'SET_KEY':
            if (!msg.provider || typeof msg.key !== 'string') {
                respondErr('SET_KEY requires provider and key');
                break;
            }
            evt.waitUntil(_setKey(msg.provider, msg.key).then(
                () => respond({ type: 'ACK' }),
                (e) => respondErr(String(e)),
            ));
            break;

        case 'DELETE_KEY':
            if (!msg.provider) { respondErr('DELETE_KEY requires provider'); break; }
            evt.waitUntil(_deleteKey(msg.provider).then(
                () => respond({ type: 'ACK' }),
                (e) => respondErr(String(e)),
            ));
            break;

        case 'CLEAR_KEYS':
            evt.waitUntil(_clearKeys().then(
                () => respond({ type: 'ACK' }),
                (e) => respondErr(String(e)),
            ));
            break;

        default:
            respondErr(`Unknown message type: ${msg.type}`);
    }
});

// ── Fetch interceptor ─────────────────────────────────────────────────────────

self.addEventListener('fetch', (evt) => {
    const provider = _providerForUrl(evt.request.url);
    if (!provider) return; // not an intercepted URL — pass through

    evt.respondWith(
        _getKey(provider).then((key) => {
            if (!key) {
                // No key stored for this provider — forward unchanged.
                // This allows providers with proxy auth (no client key) to work.
                return fetch(evt.request);
            }

            // Clone request and inject Authorization header.
            const headers = new Headers(evt.request.headers);
            headers.set('Authorization', `Bearer ${key}`);

            return fetch(new Request(evt.request, { headers }));
        }).catch(() => {
            // IDB failure — fall through to original request.
            return fetch(evt.request);
        }),
    );
});
