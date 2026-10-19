// detectors.ts: shell commands that change the system without a reported written file.
import { describe, it, expect } from 'vitest';
import { changesState } from '../detectors.ts';

describe('state changes by shell command', () => {
    it('state-changing commands', () => {
        for (const c of ['apt-get update && apt-get install -y sudo', 'chmod u-s /usr/bin/find', 'sudo chown root:root /etc/sudoers', 'echo x | tee /etc/foo',
            'systemctl restart ssh', 'usermod -aG sudo jack', "sed -i 's/a/b/' /etc/x", 'rm /tmp/x'])
            expect(changesState(c), c).toBe(true);
        for (const c of ['ls -l /etc/sudoers', 'cat /etc/sudoers', 'id', 'sudo -v', 'find / -perm -4000', 'which sudo'])
            expect(changesState(c), c).toBe(false);
    });
});
