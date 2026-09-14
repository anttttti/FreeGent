// tests/fg-sandbox-frame.test.ts — unit tests for fg-sandbox-frame.ts
//
// Runs under jsdom (see vitest.config.ts: environment: 'jsdom').
// Note: jsdom does not implement the real sandbox= iframe attribute, so tests
// use the postMessage protocol and DOM structure without true isolation testing.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
    RuntimeMessageBridge,
    SandboxedOutputFrame,
    makeSandboxedOutputFrame,
    type FrameToHostMessage,
    type HostToFrameMessage,
} from '../fg-sandbox-frame.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeContainer(): HTMLElement {
    const div = document.createElement('div');
    document.body.appendChild(div);
    return div;
}

function makeStubIframe(): HTMLIFrameElement {
    const iframe = document.createElement('iframe');
    // Simulate contentWindow so send() doesn't throw.
    Object.defineProperty(iframe, 'contentWindow', {
        get: () => ({ postMessage: vi.fn() }),
    });
    return iframe;
}

// Dispatch a MessageEvent as if it came from a sandboxed iframe.
function dispatchFrameMessage(msg: FrameToHostMessage): void {
    const event = new MessageEvent('message', { data: msg });
    window.dispatchEvent(event);
}

// ── RuntimeMessageBridge ──────────────────────────────────────────────────────

describe('RuntimeMessageBridge', () => {
    let iframe: HTMLIFrameElement;
    let bridge: RuntimeMessageBridge;

    beforeEach(() => {
        iframe = makeStubIframe();
        bridge = new RuntimeMessageBridge(iframe);
    });

    afterEach(() => {
        bridge.dispose();
    });

    it('calls onMessage handlers for fw: messages', () => {
        const handler = vi.fn();
        bridge.onMessage(handler);
        dispatchFrameMessage({ type: 'fg:ready' });
        expect(handler).toHaveBeenCalledWith({ type: 'fg:ready' });
    });

    it('ignores messages without fw: prefix', () => {
        const handler = vi.fn();
        bridge.onMessage(handler);
        window.dispatchEvent(new MessageEvent('message', { data: { type: 'other:stuff' } }));
        expect(handler).not.toHaveBeenCalled();
    });

    it('ignores null / non-object message data', () => {
        const handler = vi.fn();
        bridge.onMessage(handler);
        window.dispatchEvent(new MessageEvent('message', { data: null }));
        window.dispatchEvent(new MessageEvent('message', { data: 'raw string' }));
        expect(handler).not.toHaveBeenCalled();
    });

    it('returns an unsubscribe function that stops delivery', () => {
        const handler = vi.fn();
        const unsub = bridge.onMessage(handler);
        unsub();
        dispatchFrameMessage({ type: 'fg:ready' });
        expect(handler).not.toHaveBeenCalled();
    });

    it('multiple handlers all receive the message', () => {
        const h1 = vi.fn(); const h2 = vi.fn();
        bridge.onMessage(h1);
        bridge.onMessage(h2);
        dispatchFrameMessage({ type: 'fg:stdout', text: 'hi' });
        expect(h1).toHaveBeenCalledTimes(1);
        expect(h2).toHaveBeenCalledTimes(1);
    });

    it('dispose() stops all message delivery', () => {
        const handler = vi.fn();
        bridge.onMessage(handler);
        bridge.dispose();
        dispatchFrameMessage({ type: 'fg:ready' });
        expect(handler).not.toHaveBeenCalled();
    });

    it('send() calls postMessage on the contentWindow object', () => {
        // Use a plain object as a stand-in — avoids redefinition issues with jsdom iframes.
        const postMessage = vi.fn();
        const fakeFrame = { contentWindow: { postMessage } } as unknown as HTMLIFrameElement;
        const b = new RuntimeMessageBridge(fakeFrame);
        const msg: HostToFrameMessage = { type: 'fg:ping', nonce: 'abc' };
        b.send(msg);
        expect(postMessage).toHaveBeenCalledWith(msg, '*');
        b.dispose();
    });

    it('send() is a no-op when contentWindow is null', () => {
        const fakeFrame = { contentWindow: null } as unknown as HTMLIFrameElement;
        const b = new RuntimeMessageBridge(fakeFrame);
        // Should not throw
        expect(() => b.send({ type: 'fg:clear' })).not.toThrow();
        b.dispose();
    });

    it('a handler that throws does not break other handlers', () => {
        const bad   = vi.fn().mockImplementation(() => { throw new Error('boom'); });
        const good  = vi.fn();
        bridge.onMessage(bad);
        bridge.onMessage(good);
        // Should not propagate the exception
        expect(() => dispatchFrameMessage({ type: 'fg:ready' })).not.toThrow();
        expect(good).toHaveBeenCalled();
    });

    it('rejects messages from a non-null foreign source', () => {
        const handler = vi.fn();
        bridge.onMessage(handler);
        // Simulate a message originating from a different window (e.g. another iframe).
        // e.source is non-null and does not match the iframe's contentWindow.
        const foreignWindow = {} as Window;
        const event = new MessageEvent('message', {
            data:   { type: 'fg:ready' },
            source: foreignWindow as Window,
        });
        window.dispatchEvent(event);
        // The bridge should reject this message because source !== iframe.contentWindow.
        expect(handler).not.toHaveBeenCalled();
    });
});

// ── SandboxedOutputFrame ──────────────────────────────────────────────────────

describe('SandboxedOutputFrame', () => {
    let container: HTMLElement;

    beforeEach(() => {
        container = makeContainer();
    });

    afterEach(() => {
        container.remove();
    });

    it('appends an iframe to the container', () => {
        const frame = new SandboxedOutputFrame(container);
        expect(container.querySelector('iframe')).toBeTruthy();
        frame.dispose();
    });

    it('iframe has sandbox="allow-scripts …" (no allow-same-origin)', () => {
        const frame = new SandboxedOutputFrame(container);
        const sandbox = frame.iframe.getAttribute('sandbox') ?? '';
        // Security invariant: allow-same-origin must never be present.
        expect(sandbox).not.toContain('allow-same-origin');
        // Required permissions (allow-pointer-lock, allow-modals, allow-downloads
        // were added intentionally — see fg-sandbox-frame.ts header comments).
        expect(sandbox).toContain('allow-scripts');
        expect(sandbox).toContain('allow-pointer-lock');
        expect(sandbox).toContain('allow-modals');
        expect(sandbox).toContain('allow-downloads');
        frame.dispose();
    });

    it('iframe has srcdoc set', () => {
        const frame = new SandboxedOutputFrame(container, { initialHtml: '<p>Hello</p>' });
        expect(frame.iframe.srcdoc).toContain('<p>Hello</p>');
        frame.dispose();
    });

    it('render() updates iframe srcdoc', () => {
        const frame = new SandboxedOutputFrame(container);
        frame.render('<h1>Updated</h1>');
        expect(frame.iframe.srcdoc).toContain('<h1>Updated</h1>');
        frame.dispose();
    });

    it('render() includes the runtime shim', () => {
        const frame = new SandboxedOutputFrame(container);
        frame.render('<p>test</p>');
        // The shim marks itself with the fg:ready signal
        expect(frame.iframe.srcdoc).toContain('fg:ready');
        frame.dispose();
    });

    it('dispose() removes the iframe from the DOM', () => {
        const frame = new SandboxedOutputFrame(container);
        frame.dispose();
        expect(container.querySelector('iframe')).toBeNull();
    });

    it('expose bridge property of type RuntimeMessageBridge', () => {
        const frame = new SandboxedOutputFrame(container);
        expect(frame.bridge).toBeInstanceOf(RuntimeMessageBridge);
        frame.dispose();
    });

    it('bridge receives fg:stdout messages dispatched from window', () => {
        const frame   = new SandboxedOutputFrame(container);
        const handler = vi.fn();
        frame.bridge.onMessage(handler);
        dispatchFrameMessage({ type: 'fg:stdout', text: 'output line' });
        expect(handler).toHaveBeenCalledWith({ type: 'fg:stdout', text: 'output line' });
        frame.dispose();
    });

    it('eval() resolves when frame replies fg:result', async () => {
        const frame = new SandboxedOutputFrame(container);
        // Mock contentWindow.postMessage to capture the eval request.
        let capturedMsg: any;
        Object.defineProperty(frame.iframe, 'contentWindow', {
            get: () => ({ postMessage: (m: any) => { capturedMsg = m; } }),
            configurable: true,
        });

        const evalPromise = frame.eval('1 + 1');
        // Simulate the frame replying
        dispatchFrameMessage({ type: 'fg:result', id: capturedMsg.id, value: 2 });
        await expect(evalPromise).resolves.toBe(2);
        frame.dispose();
    });

    it('eval() rejects when frame replies fg:error', async () => {
        const frame = new SandboxedOutputFrame(container);
        let capturedMsg: any;
        Object.defineProperty(frame.iframe, 'contentWindow', {
            get: () => ({ postMessage: (m: any) => { capturedMsg = m; } }),
            configurable: true,
        });

        const evalPromise = frame.eval('throw new Error("bad")');
        dispatchFrameMessage({ type: 'fg:error', id: capturedMsg.id, message: 'bad' });
        await expect(evalPromise).rejects.toThrow('bad');
        frame.dispose();
    });

    it('eval() rejects on timeout', async () => {
        const frame = new SandboxedOutputFrame(container);
        Object.defineProperty(frame.iframe, 'contentWindow', {
            get: () => ({ postMessage: vi.fn() }),
            configurable: true,
        });
        await expect(frame.eval('1', 50)).rejects.toThrow('timed out');
        frame.dispose();
    });
});

// ── makeSandboxedOutputFrame ──────────────────────────────────────────────────

describe('makeSandboxedOutputFrame', () => {
    let container: HTMLElement;

    beforeEach(() => { container = makeContainer(); });
    afterEach(() => { container.remove(); });

    it('returns frame and bridge', () => {
        const { frame, bridge } = makeSandboxedOutputFrame(container, '<p>Hi</p>');
        expect(frame).toBeInstanceOf(SandboxedOutputFrame);
        expect(bridge).toBeInstanceOf(RuntimeMessageBridge);
        frame.dispose();
    });

    it('renders the given HTML into the iframe', () => {
        const { frame } = makeSandboxedOutputFrame(container, '<canvas id="c"></canvas>');
        expect(frame.iframe.srcdoc).toContain('<canvas id="c">');
        frame.dispose();
    });
});
