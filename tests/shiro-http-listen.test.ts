import { describe, it, expect } from 'vitest';
import { createHttpModule } from '../shiro/node-compat/modules/http';

// The sandbox cannot accept connections: listen() used to report success for a server nothing could reach.
describe('shell http server', () => {
    it('refuses to listen instead of reporting a server that cannot be reached', () => {
        const http: any = createHttpModule({ ctx: {} as any, fakeConsole: { log() {}, warn() {} }, getBuiltinModule: () => null });
        const server = http.createServer(() => {});
        expect(() => server.listen(3000)).toThrow(/EACCES|cannot accept connections/);
        expect(server.address()).toBeNull();
    });
});
