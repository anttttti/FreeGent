
describe('opencode §5: the prompt template setting reaches the main agent', () => {
    it('is in the system prompt under its own heading when set, and absent when empty', async () => {
        const W: any = window;
        W.setMainAgentRole?.('director');
        localStorage.setItem('fg_agent_prompt_template', 'PROBE_TEMPLATE_MARKER_9137: prefer small commits.');
        expect(W.buildSystemPrompt()).toMatch(/## Instructions from your settings\nPROBE_TEMPLATE_MARKER_9137: prefer small commits\./);
        localStorage.setItem('fg_agent_prompt_template', '   ');
        expect(W.buildSystemPrompt()).not.toMatch(/Instructions from your settings/);
        localStorage.removeItem('fg_agent_prompt_template');
    });
});
