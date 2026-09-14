// window-terminal.ts — stub for FreeGent integration
export interface WindowTerminal {
    writeOutput(text: string): void;
    close(): void;
}
export function openWindowTerminal(_opts?: unknown): void {}
