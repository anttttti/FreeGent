// terminal.ts — stub for FreeGent integration
// shell.ts imports `type { ShiroTerminal }` only; no xterm dependency needed here.

export interface ShiroTerminal {
    writeOutput(text: string): void;
    enterStdinPassthrough(cb: (data: string) => void, forceExitCb?: () => void): void;
    exitStdinPassthrough(): void;
    enterRawMode(cb: (key: string) => void): void;
    exitRawMode(): void;
    isRawMode(): boolean;
    onResize(cb: (cols: number, rows: number) => void): () => void;
    getSize(): { rows: number; cols: number };
    getBufferContent?(): string;
    term: any;
}
