// iframe-server.ts — stub for FreeGent integration
export interface VirtualRequest {
    method: string;
    path: string;
    headers?: Record<string, string>;
    body?: string | null;
    query?: Record<string, string>;
}
export interface VirtualResponse {
    status?: number;
    statusText?: string;
    headers?: Record<string, string>;
    body?: string | Uint8Array | object;
    contentType?: string;
}
export type RequestHandler = (req: VirtualRequest) => Promise<VirtualResponse> | VirtualResponse;

export interface IframeServerManager {
    serve(port: number, handler: RequestHandler, label?: string): (() => void) | void;
    fetch(port: number, path?: string, opts?: Partial<VirtualRequest>): Promise<VirtualResponse>;
    close(port: number): void;
    createIframe(port: number, container?: HTMLElement, opts?: { path?: string; width?: string; height?: string }): Promise<HTMLElement>;
    isPortInUse(port: number): boolean;
}
export const iframeServer: IframeServerManager = {
    serve() {},
    async fetch() { return { status: 404, body: 'not implemented' }; },
    close() {},
    async createIframe() { return document.createElement('iframe'); },
    isPortInUse() { return false; },
};

export function openInIframe(_url: string, _opts?: unknown): void {}
export function closeIframe(): void {}
