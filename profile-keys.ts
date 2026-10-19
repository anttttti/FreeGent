// profile-keys.ts — which saved settings are credentials (never written to the profile file).
//
// Credentials only. The old pattern /key|token|secret|password/ also caught fg_agent_compact_tokens, so a compaction threshold set with /set
// vanished on exit (TUI report case 026); a token budget is a setting, a "…_token" is a credential.
const CREDENTIAL = /key|secret|password|passphrase|(?:^|_)token$/i;
export const isCredentialKey = (k: string): boolean => CREDENTIAL.test(k);
