import type { Command } from './index';

/** Real GNU make runs through the explicitly selected native execution backend. */
export const make: Command = {
  name:'make', description:'Build using GNU make (requires native execution)',
  parityScope:'capability-only',
  route:'native-only', requirements:['native build processes'],
  async exec(ctx) {
    ctx.stderr += 'make: recipe execution is unavailable in the browser shell; select native execution\n';
    return 2;
  },
};
