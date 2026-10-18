// service-manager.ts — stub for FreeGent integration

export interface ServiceManager {
    start(name: string): void;
    stop(name: string): void;
    getSyslog(): string;
}
export const serviceManager: ServiceManager = {
    start() {},
    stop() {},
    getSyslog() { return ''; },
};
