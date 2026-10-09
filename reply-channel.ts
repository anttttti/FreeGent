// reply-channel.ts — FreeGent: a task whose counterpart (a customer, a user) is reached through a
// tool, not through chat output. The benchmark runner passes a hint that says how
// (--reply-channel-hint); turn-protocol uses it in place of the "you cannot ask the user" redirection.

let _hint = '';

export function setReplyChannelHint(hint: string): void { _hint = String(hint || '').trim(); }
export function getReplyChannelHint(): string { return _hint; }
