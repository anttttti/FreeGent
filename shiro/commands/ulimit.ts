import type { Command } from './index';

export const ULIMIT_UNAVAILABLE = 'ulimit: kernel resource limits are unavailable in the browser; select native execution\n';

export const ulimit: Command = {
  name: 'ulimit',
  description: 'Control user resource limits (requires native execution)',
  route: 'native-only',
  parityScope: 'capability-only',
  requirements: ['kernel resource limits'],
  async exec(ctx) {
    ctx.stderr += ULIMIT_UNAVAILABLE;
    return 2;
  },
};
