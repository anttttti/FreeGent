// server-window.ts — stub for FreeGent integration
export interface ServerWindow {
    url: string;
    close(): void;
}
export function openServerWindow(_url: string, _opts?: unknown): void {}
