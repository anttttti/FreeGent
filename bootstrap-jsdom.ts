// bootstrap-jsdom.js — sets up browser globals before any app module is imported.
// Import this FIRST in the headless entry point (fg-run.js).
// Exports `dom` so headless-runner.js can eval classic scripts into the same context.
// Never imported by browser code.
import { JSDOM, VirtualConsole } from 'jsdom';
import { IDBFactory } from 'fake-indexeddb';

// Forward error/warn from classic scripts to Node stderr.
// log/info go nowhere to avoid polluting stdout (fg-run.js uses stdout for patch output).
const virtualConsole = new VirtualConsole();
virtualConsole.on('error',     (...a) => process.stderr.write('[agent] ' + a.join(' ') + '\n'));
virtualConsole.on('warn',      (...a) => process.stderr.write('[agent] ' + a.join(' ') + '\n'));
virtualConsole.on('jsdomError', e    => {}); // suppress jsdom HTML parse errors

export { virtualConsole };

export const dom = new JSDOM(`<!DOCTYPE html><html><body>
  <div id="agent-messages"></div>
  <div id="workspace-file-list"></div>
  <span id="agent-token-label"></span>
  <span id="agent-model-label"></span>
  <span id="provider-label"></span>
  <button id="agent-action-btn">▶</button>
  <div id="agent-input" contenteditable="true"></div>
  <div id="img-strip" style="display:none"></div>
  <div id="fsa-badge" style="display:none"><span id="fsa-name"></span></div>
  <div id="settings-modal" style="display:none"></div>
  <input type="radio" name="provider" value="google">
  <input type="radio" name="provider" value="mistral">
  <input type="radio" name="provider" value="openai" checked>
  <div id="google-fields"  style="display:none"></div>
  <div id="mistral-fields" style="display:none"></div>
  <div id="oai-fields"></div>
  <input id="gemini-key"    type="password">
  <select id="gemini-model"><option value="gemini-2.5-flash" selected>gemini-2.5-flash</option></select>
  <input id="mistral-key"   type="password">
  <select id="mistral-model"><option value="mistral-medium-3.5" selected>mistral-medium-3.5</option></select>
  <input id="oai-url"       type="url">
  <input id="oai-key"       type="password">
  <input id="oai-model"     type="text">
  <input id="sandbox-url"   type="url">
  <input id="sandbox-key"   type="password">
  <select id="search-provider">
    <option value="auto" selected>Auto</option>
    <option value="tavily">Tavily</option>
    <option value="brave">Brave</option>
    <option value="wikipedia">Wikipedia</option>
  </select>
  <input id="tavily-key"   type="password">
  <input id="search-proxy" type="url">
  <input id="brave-key"    type="password">
</body></html>`, {
    url:              'http://freegent.internal',
    pretendToBeVisual: true,
    runScripts:       'dangerously', // needed so dom.window.eval() works for classic scripts
    virtualConsole,
});

const { window } = dom;

// Populate dom.window with Node.js globals that browser APIs expect.
// fetch: Node 18+ native; fall back gracefully.
window.fetch     = globalThis.fetch;
window.indexedDB = new IDBFactory();
window.alert     = () => {};
window.confirm   = () => true;
// marked is used by chat-render.js for markdown rendering.
window.marked    = { parse: t => `<p>${t}</p>` };
// Use native Node.js AbortController/AbortSignal so fetch() receives the right
// realm's signal. jsdom's AbortSignal fails undici's instanceof check.
window.AbortController = globalThis.AbortController;
window.AbortSignal     = globalThis.AbortSignal;
// JSDOM doesn't implement matchMedia; polyfill so workspace.ts drag-handle guard
// doesn't throw an unhandled rejection when DOMContentLoaded fires headless.
(window as any).matchMedia = (query: string) => ({
    matches: false, media: query, onchange: null,
    addListener: () => {}, removeListener: () => {},
    addEventListener: () => {}, removeEventListener: () => {},
    dispatchEvent: () => false,
});

// Proxy dom.window so that every `Object.assign(window, {...})` call in an ES
// module also lands on globalThis. Without this, ES modules accessing another
// module's bridged exports as free variables (e.g. llm-shared.js calling
// getProvider()) fail with ReferenceError because free variables in ES module
// scope resolve against globalThis, not dom.window. In-browser window===globalThis
// so no issue there; this proxy only matters in headless Node.js.
//
// The `get` trap binds function values to the real window (target) before returning
// them. This ensures jsdom's internal instanceof/brand checks pass when methods
// like addEventListener() are called through the proxy (otherwise `this` would be
// the Proxy itself, which is not a valid EventTarget instance).
const windowProxy = new Proxy(window, {
    get(target, prop) {
        const val = target[prop];
        return typeof val === 'function' ? val.bind(target) : val;
    },
    set(target, prop, value) {
        try { target[prop] = value; } catch {}
        try { globalThis[prop] = value; } catch {}
        return true;
    },
    defineProperty(target, prop, desc) {
        try { Object.defineProperty(target, prop, desc); } catch {}
        try { Object.defineProperty(globalThis, prop, desc); } catch {}
        return true;
    },
});

// Make globalThis.window point at the proxy so ES modules doing
// `Object.assign(window, {...})` trigger the mirroring trap.
globalThis.window       = windowProxy;
globalThis.document     = window.document;
globalThis.indexedDB    = window.indexedDB;
globalThis.localStorage = window.localStorage;
globalThis.sessionStorage = window.sessionStorage;
globalThis.alert        = window.alert;
globalThis.confirm      = window.confirm;
globalThis.marked       = window.marked;
globalThis.btoa         = (s) => Buffer.from(s, 'binary').toString('base64');
globalThis.atob         = (s) => Buffer.from(s, 'base64').toString('binary');
// navigator / location / history are getter-only on Node.js globalThis — use defineProperty.
for (const [k, v] of [['navigator', window.navigator], ['location', window.location], ['history', window.history]]) {
    try { Object.defineProperty(globalThis, k, { value: v, writable: true, configurable: true }); } catch {}
}
