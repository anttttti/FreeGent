// codex report 8, cases 281/282/296: the read-only viewer's Stop clicked the hidden main action button.
// After the run ended that button is Send, so a later Stop click submitted the owner chat's unsent draft.
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';

const W = window as any;
let S: any;

beforeAll(async () => {
    S = await import('../state.ts');
    await import('../chat-state.ts');
});

beforeEach(() => {
    localStorage.clear();
    document.body.innerHTML = `<div id="wrap"><div id="agent-messages"></div></div>
        <button id="agent-action-btn"></button>`;
    localStorage.setItem('fg_chat_list', JSON.stringify([
        { id: 'a', name: 'Chat A', createdAt: 1, lastAt: 2 },
        { id: 'b', name: 'Chat B', createdAt: 3, lastAt: 4 },
    ]));
});

describe('read-only viewer Stop', () => {
    it('stops a running turn, and never presses the main action button once the run is over', async () => {
        const mainClick = vi.fn(); document.getElementById('agent-action-btn')!.addEventListener('click', mainClick);
        const stopNow = vi.fn(); W.stopNow = stopNow;
        S.setAgentStreaming(true);
        await W.switchToChat('a');
        const stop = document.getElementById('fg-chat-viewer-stop') as HTMLButtonElement;
        expect(stop).toBeTruthy();
        stop.click();
        expect(stopNow).toHaveBeenCalledTimes(1);
        expect(mainClick).not.toHaveBeenCalled();

        // the run ends: the stale Stop and its "a turn is running" claim go away
        S.setAgentStreaming(false);
        expect(document.getElementById('fg-chat-viewer-stop')).toBeNull();
        expect(document.querySelector('.fg-chat-viewer-bar span')!.textContent).toMatch(/finished/);
        expect(mainClick).not.toHaveBeenCalled();
    });
});
