// service-manager.ts — stub for FreeGent integration
export type ServiceStatus = 'running' | 'stopped' | 'failed';
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
