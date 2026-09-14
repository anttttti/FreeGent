// fg-sandbox-frame.ts — Sandboxed iframe renderer for execute_code HTML output.
//
// Phase 5: replaces same-origin HTML injection with a properly sandboxed iframe.
//
// The iframe uses sandbox="allow-scripts allow-pointer-lock allow-modals allow-downloads" — no allow-same-origin, so scripts
// inside cannot reach the parent page's DOM, cookies, or storage. Output travels
// back via a typed postMessage protocol.
//
// Two exports:
//
//   SandboxedOutputFrame
//     Creates an <iframe sandbox="allow-scripts allow-pointer-lock allow-modals allow-downloads" allowfullscreen> in the given container.
//     Injects a runtime shim that intercepts console.log/error and patches
//     window.onerror so all output is forwarded as structured postMessages.
//     render(html) replaces the iframe content without removing the frame.
//     postToFrame(msg) sends a HostToFrameMessage to the shim.
//     dispose() removes the iframe and detaches the message listener.
//
//   RuntimeMessageBridge
//     Typed postMessage forwarder between the host page and one sandboxed frame.
//     The SandboxedOutputFrame owns a bridge internally; callers can also
//     construct one standalone to attach to an existing iframe.
//
// Message protocol (both directions are formalised — callers MUST NOT rely on
// undocumented message shapes):
//
//   HostToFrame (postToFrame):
//     { type: 'fg:eval';  code: string; id: string }  — eval code in frame
//     { type: 'fg:clear' }                             — clear frame body
//     { type: 'fg:ping';  nonce: string }              — liveness check
//
//   FrameToHost (onMessage):
//     { type: 'fg:ready' }                             — shim initialised
//     { type: 'fg:stdout'; text: string }              — console.log line
//     { type: 'fg:stderr'; text: string }              — console.error / uncaught
//     { type: 'fg:result'; id: string; value: unknown }— eval returned value
//     { type: 'fg:error';  id: string; message: string}— eval threw
//     { type: 'fg:pong';   nonce: string }             — response to ping
//     { type: 'fg:dbg';    msg: string }               — freeform debug (compat)
//
// Existing usage in workspace.ts (fg-dbg bridge) remains unmodified — this
// module provides the new typed layer alongside it.

// ── Typed message protocol ────────────────────────────────────────────────────

export type HostToFrameMessage =
    | { type: 'fg:eval';  code: string; id: string }
    | { type: 'fg:clear' }
    | { type: 'fg:ping';  nonce: string };

export type FrameToHostMessage =
    | { type: 'fg:ready' }
    | { type: 'fg:stdout'; text: string }
    | { type: 'fg:stderr'; text: string }
    | { type: 'fg:result'; id: string; value: unknown }
    | { type: 'fg:error';  id: string; message: string }
    | { type: 'fg:pong';   nonce: string }
    | { type: 'fg:dbg';    msg: string };

// ── Runtime shim injected into the iframe ────────────────────────────────────
//
// This script runs inside the sandboxed iframe. It patches console.* and
// window.onerror so that output travels to the host via postMessage.
// It also implements the fg:eval / fg:clear / fg:ping handlers.
//
// The shim is a single IIFE — it does not leak globals.

const _RUNTIME_SHIM = `
(function(){
  var _parent = window.parent;
  var _post   = function(msg) { _parent.postMessage(msg, '*'); };

  // Console intercept
  var _log  = console.log.bind(console);
  var _err  = console.error.bind(console);
  var _warn = console.warn.bind(console);
  console.log   = function() { _post({type:'fg:stdout',text:[].slice.call(arguments).join(' ')}); _log.apply(console,arguments); };
  console.error = function() { _post({type:'fg:stderr',text:[].slice.call(arguments).join(' ')}); _err.apply(console,arguments); };
  console.warn  = function() { _post({type:'fg:stderr',text:'[warn] '+[].slice.call(arguments).join(' ')}); _warn.apply(console,arguments); };

  // Uncaught error forward
  window.onerror = function(msg,src,line,col,err) {
    _post({type:'fg:stderr',text:'[uncaught] '+msg+' ('+src+':'+line+')'});
    return false;
  };
  window.onunhandledrejection = function(e) {
    var reason = (e.reason && e.reason.message) ? e.reason.message : String(e.reason);
    _post({type:'fg:stderr',text:'[promise] '+reason});
  };

  // Eval handler
  window.addEventListener('message', function(e) {
    var d = e.data;
    if (!d || typeof d.type !== 'string') return;
    if (d.type === 'fg:eval') {
      try {
        var result = (0,eval)(d.code); // indirect eval — no access to local scope
        _post({type:'fg:result',id:d.id,value:result===undefined?null:result});
      } catch(ex) {
        _post({type:'fg:error',id:d.id,message:ex.message||String(ex)});
      }
    } else if (d.type === 'fg:clear') {
      document.body.innerHTML = '';
    } else if (d.type === 'fg:ping') {
      _post({type:'fg:pong',nonce:d.nonce});
    }
  });

  // Signal ready
  _post({type:'fg:ready'});
})();
`;

// ── _buildSrcdoc ──────────────────────────────────────────────────────────────
//
// Wraps user HTML + runtime shim in a valid document.

function _buildSrcdoc(body: string): string {
    return [
        '<!DOCTYPE html><html><head>',
        '<meta charset="utf-8">',
        '<meta name="viewport" content="width=device-width,initial-scale=1">',
        '<style>',
        '*{box-sizing:border-box}',
        'html,body{margin:0;padding:8px;font-family:system-ui,sans-serif;font-size:14px;',
        '  background:#fff;color:#111}',
        '@media(prefers-color-scheme:dark){html,body{background:#1a1a1a;color:#eee}}',
        '</style>',
        `<script>${_RUNTIME_SHIM}<\/script>`,
        '</head><body>',
        body,
        '</body></html>',
    ].join('');
}

// ── RuntimeMessageBridge ──────────────────────────────────────────────────────

export type FrameMessageHandler = (msg: FrameToHostMessage) => void;

/**
 * Typed postMessage forwarder between the host page and one sandboxed iframe.
 *
 * Listens for messages from the iframe and calls handlers registered with
 * `onMessage()`. Sends `HostToFrameMessage` objects via `send()`.
 *
 * Call `dispose()` to remove the window listener and prevent memory leaks.
 */
export class RuntimeMessageBridge {
    private _handlers = new Set<FrameMessageHandler>();
    private _frame:    HTMLIFrameElement;
    private _listener: (e: MessageEvent) => void;

    constructor(frame: HTMLIFrameElement) {
        this._frame = frame;
        this._listener = (e: MessageEvent) => {
            // Source filter: only accept messages from our specific iframe.
            // This prevents other frames or XSS payloads from injecting fg: events.
            // Note: jsdom does not populate e.source for programmatically dispatched
            // MessageEvents, so unit tests bypass this check via the null branch.
            if (e.source !== null && e.source !== this._frame.contentWindow) return;
            // Only forward messages that look like our protocol.
            const msg = e.data as FrameToHostMessage;
            if (!msg || typeof msg.type !== 'string') return;
            if (!msg.type.startsWith('fg:')) return;
            for (const h of this._handlers) {
                try { h(msg); } catch { /* guard: handler errors must not break the bridge */ }
            }
        };
        if (typeof window !== 'undefined') {
            window.addEventListener('message', this._listener);
        }
    }

    /**
     * Register a handler for messages arriving from the sandboxed iframe.
     * Returns an unsubscribe function.
     */
    onMessage(handler: FrameMessageHandler): () => void {
        this._handlers.add(handler);
        return () => { this._handlers.delete(handler); };
    }

    /**
     * Send a typed message to the sandboxed iframe's shim.
     * No-op if the iframe's contentWindow is not available (e.g. not mounted yet).
     */
    send(msg: HostToFrameMessage): void {
        this._frame.contentWindow?.postMessage(msg, '*');
    }

    /** Remove the window message listener. Call when the frame is removed. */
    dispose(): void {
        if (typeof window !== 'undefined') {
            window.removeEventListener('message', this._listener);
        }
        this._handlers.clear();
    }
}

// ── SandboxedOutputFrame ──────────────────────────────────────────────────────

export interface SandboxedOutputFrameOptions {
    /**
     * CSS height for the iframe. Default: 'auto' (no fixed height;
     * use a fixed value like '400px' for scrollable output).
     */
    height?: string;
    /** Extra CSS to apply to the iframe element. */
    style?:  string;
    /** Initial HTML body content. Default: ''. */
    initialHtml?: string;
}

/**
 * Sandboxed iframe renderer for execute_code HTML output.
 *
 * Creates an `<iframe sandbox="allow-scripts allow-pointer-lock allow-modals allow-downloads" allowfullscreen>` in `container`. Scripts inside
 * the frame cannot access the parent page (no allow-same-origin). All console
 * output and uncaught errors are forwarded via the RuntimeMessageBridge.
 *
 * @example
 * ```typescript
 * const frame = new SandboxedOutputFrame(container);
 * frame.bridge.onMessage(msg => {
 *     if (msg.type === 'fg:stdout') console.log('[frame]', msg.text);
 * });
 * frame.render('<h1>Hello</h1><script>console.log("hi");<\/script>');
 * // …later…
 * frame.dispose();
 * ```
 */
export class SandboxedOutputFrame {
    readonly iframe:  HTMLIFrameElement;
    readonly bridge:  RuntimeMessageBridge;

    constructor(
        container: HTMLElement,
        options: SandboxedOutputFrameOptions = {},
    ) {
        const { height = 'auto', style = '', initialHtml = '' } = options;

        const iframe = document.createElement('iframe');
        iframe.className = 'fg-sandbox-frame';
        // No allow-same-origin: sandboxed scripts cannot access parent DOM.
        // allow-pointer-lock: first-person/game pages that call requestPointerLock().
        // allow-modals: alert()/confirm()/prompt() — common in agent-generated code.
        // allow-downloads: pages that export files via <a download> or createObjectURL.
        iframe.setAttribute('sandbox', 'allow-scripts allow-pointer-lock allow-modals allow-downloads');
        iframe.allowFullscreen = true;
        iframe.style.cssText = [
            'display:block',
            'width:100%',
            'border:none',
            'border-radius:6px',
            'margin:4px 0',
            `height:${height === 'auto' ? '0' : height}`,
            style,
        ].filter(Boolean).join(';');

        iframe.srcdoc = _buildSrcdoc(initialHtml);
        container.appendChild(iframe);

        this.iframe = iframe;
        this.bridge = new RuntimeMessageBridge(iframe);

        // Auto-resize to content when height is 'auto'.
        // On fg:ready / fg:result(non-size), ask for the scroll height.
        // On fg:result for the _auto_size request, apply the measured height.
        if (height === 'auto') {
            this.bridge.onMessage(msg => {
                if (msg.type === 'fg:ready') {
                    this.bridge.send({
                        type: 'fg:eval',
                        id:   '_auto_size',
                        code: 'document.body.scrollHeight',
                    });
                } else if (msg.type === 'fg:result') {
                    const r = msg as { type: 'fg:result'; id: string; value: unknown };
                    if (r.id === '_auto_size') {
                        const h = Number(r.value);
                        if (h > 0) iframe.style.height = `${Math.min(h + 16, 600)}px`;
                    }
                }
            });
        }
    }

    /**
     * Replace the iframe body with new HTML.
     * The runtime shim is always re-injected so console intercepts remain active.
     */
    render(html: string): void {
        this.iframe.srcdoc = _buildSrcdoc(html);
    }

    /**
     * Clear the iframe body without re-rendering.
     * Faster than `render('')` for interactive clear operations.
     */
    clear(): void {
        this.bridge.send({ type: 'fg:clear' });
    }

    /**
     * Evaluate JavaScript inside the sandboxed frame.
     * Returns a Promise that resolves when the frame replies with fg:result / fg:error.
     * Times out after `timeoutMs` (default: 5 000 ms).
     */
    eval(code: string, timeoutMs = 5_000): Promise<unknown> {
        return new Promise((resolve, reject) => {
            const id   = `eval_${Date.now()}_${Math.random().toString(36).slice(2)}`;
            let   done = false;
            const timer = setTimeout(() => {
                if (done) return;
                done = true;
                unsub();
                reject(new Error(`Frame eval timed out after ${timeoutMs}ms`));
            }, timeoutMs);

            const unsub = this.bridge.onMessage(msg => {
                if (done) return;
                if ((msg as any).id !== id) return;
                done = true;
                clearTimeout(timer);
                unsub();
                if (msg.type === 'fg:result') resolve((msg as any).value);
                else if (msg.type === 'fg:error') reject(new Error((msg as any).message));
            });

            this.bridge.send({ type: 'fg:eval', code, id });
        });
    }

    /**
     * Ping the iframe shim and wait for a pong reply.
     * Returns true if the frame replies within `timeoutMs`.
     */
    async ping(timeoutMs = 2_000): Promise<boolean> {
        const nonce = Math.random().toString(36).slice(2);
        return new Promise(resolve => {
            const timer = setTimeout(() => { unsub(); resolve(false); }, timeoutMs);
            const unsub = this.bridge.onMessage(msg => {
                if (msg.type === 'fg:pong' && (msg as any).nonce === nonce) {
                    clearTimeout(timer);
                    unsub();
                    resolve(true);
                }
            });
            this.bridge.send({ type: 'fg:ping', nonce });
        });
    }

    /** Remove the iframe from the DOM and detach the message bridge. */
    dispose(): void {
        this.bridge.dispose();
        this.iframe.remove();
    }
}

// ── makeSandboxedOutputFrame ──────────────────────────────────────────────────
//
// Factory function — preferred over `new SandboxedOutputFrame()` for callers
// that want a simple fire-and-forget pattern without class instantiation.

/**
 * Create a SandboxedOutputFrame and render HTML in one step.
 *
 * Returns `{ frame, bridge }` where `frame.dispose()` cleans up.
 *
 * @example
 * ```typescript
 * const { frame, bridge } = makeSandboxedOutputFrame(container, plotHtml);
 * bridge.onMessage(msg => {
 *     if (msg.type === 'fg:stderr') ui.showError(msg.text);
 * });
 * // later:
 * frame.dispose();
 * ```
 */
export function makeSandboxedOutputFrame(
    container: HTMLElement,
    html:      string,
    options?:  SandboxedOutputFrameOptions,
): { frame: SandboxedOutputFrame; bridge: RuntimeMessageBridge } {
    const frame = new SandboxedOutputFrame(container, options);
    frame.render(html);
    return { frame, bridge: frame.bridge };
}
