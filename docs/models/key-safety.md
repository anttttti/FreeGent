# Keep your keys safe

API keys you type into **Settings → Credentials** are stored in your browser, for the site you opened. This page explains who can read them there, and what you can do about it, from the cheapest steps to the strongest.

## Who can read a saved key

The key fields show dots, but that only stops someone reading over your shoulder. The keys are stored in the browser's `localStorage` as plain text, so they can be read by:

- **anyone using your browser profile**: they open the browser's developer tools, or simply use FreeGent with your keys;
- **anything running as your user on the computer**: the browser keeps `localStorage` in files in your profile folder, and it does not encrypt them;
- **someone with your disk**, a backup or a copy of the profile, unless the disk is encrypted;
- **a script injected into the FreeGent page itself**.

They cannot be read by:

- **code the agent runs**: JavaScript, Python and bash run in sandboxes that have no access to the page's storage;
- **other people's accounts on the same computer**: your browser profile is private to your OS account;
- **the logs you send**: chat logs and developer logs have saved keys replaced with `[redacted]`, and so do provider and MCP error messages that echo a key back.

## Everyday protection

These cost nothing and cover most cases:

- **One OS account (or at least one browser profile) per person.** Someone using their own account cannot read yours.
- **Lock the screen** when you step away.
- **Full-disk encryption** (FileVault, BitLocker, LUKS) protects the profile files when the computer is off, lost or stolen.
- **Don't run untrusted programs as your own user.** They can read your browser's files, and every other file you own.

## Limit what a leaked key can do

Whatever the storage, a key that cannot spend much cannot cost much:

- **Prefer free-tier keys.** Most [default providers](providers.md) have free tiers; a key without billing cannot run up a bill.
- **Set a spending limit on keys that can spend.** OpenRouter, for example, lets you give each key its own credit limit. Check your provider's key settings.
- **Use a separate key per device or browser**, named so you can tell them apart. If one leaks, revoke only that one.
- **Revoke a key you think leaked** in your provider's console, and paste a new one. Changing it in FreeGent alone is not enough.

## Keep keys out of the browser

The strongest option is for the page never to hold the key:

- **Run FreeGent yourself** and put the keys in `~/.config/freegent/credentials`. The page receives only placeholders; the local server adds the real key to requests for that provider's own host. See [Local or self-hosted](../local/index.md#api-keys).
- **Host your own Worker** and store your provider keys there as Worker secrets. Your browser then holds only the [Developer key](access.md#developer-key), which you can change in one place. See [WebUI](../local/webui.md).
