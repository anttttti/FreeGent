// exec-sandbox/workspace-rpc.ts — stands in for ../workspace inside the exec sandbox bundle.
//
// shiro/fg-filesystem.ts imports these four functions from ../workspace; the bundle build
// resolves that import here, so the shell's /workspace files are the page's workspace, reached
// through the page instead of the page's IndexedDB (which an opaque-origin frame can't open).

import { workspaceCall } from './channel';

export const agentWriteFile    = (name: string, content: string, encoding: string | null = null): Promise<void> =>
    workspaceCall('agentWriteFile', [name, content, encoding]);
export const agentDeleteFile   = (name: string): Promise<void> => workspaceCall('agentDeleteFile', [name]);
export const agentListFiles    = (): Promise<any[]> => workspaceCall('agentListFiles', []);
export const readWorkspaceFile = (name: string): Promise<any> => workspaceCall('readWorkspaceFile', [name]);
