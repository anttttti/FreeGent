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
- **Connect OpenRouter instead of pasting a key.** **Connect** next to the OpenRouter field sends you to openrouter.ai to approve a key for FreeGent and brings you back with it saved; nothing is copied by hand. The key is labelled "FreeGent" in your OpenRouter account, where you can give it a credit limit or revoke it. Do the same on each device and each gets its own key.
- **Use a separate key per device or browser**, named so you can tell them apart. If one leaks, revoke only that one.
- **Revoke a key you think leaked** in your provider's console, and paste a new one. Changing it in FreeGent alone is not enough.

## Keep keys out of the browser

The strongest option is for the page never to hold the key:

- **Run FreeGent yourself** and put the keys in `~/.config/freegent/credentials`. The page receives only placeholders; the local server adds the real key to requests for that provider's own host. See [Local or self-hosted](../local/index.md#api-keys).
- **Host your own Worker** and store your provider keys there as Worker secrets. Your browser then holds only the [Developer key](access.md#developer-key), which you can change in one place. See [WebUI](../local/webui.md).

## Key lock with a passkey

**Settings → Credentials → Key lock → 🔑 Lock with a passkey…** encrypts your saved keys with a passkey: Touch ID or Face ID, Windows Hello, your phone, or a security key, whichever your browser offers. FreeGent then asks for the passkey each time it opens. Off by default.

- **What it covers:** the API keys, the Developer key, the GitHub token and the MCP servers (with their credentials). Keys saved on individual custom models (Settings → Models) are not encrypted.
- **How it works:** the passkey's authenticator derives a secret only after it has verified you (fingerprint, face, PIN), through the WebAuthn PRF extension. FreeGent turns that secret into an AES-256 key and encrypts the keys with it. The secret is never stored: the browser holds only the encrypted keys and the passkey's ID.
- **When FreeGent opens:** a dialog offers **🔑 Unlock with passkey**. **Continue without keys** opens FreeGent without them (guest access and local models still work); unlock later in Settings → Credentials.
- **What it protects:** while FreeGent is closed or locked, someone using your browser profile, or a copy of it, cannot read the keys. **Lock now** locks them without closing the tab.
- **What it does not protect:** an open, unlocked FreeGent tab. While it is unlocked, the keys are in the page's memory, readable with developer tools like before. Lock it or close the tab before leaving the browser to someone else.
- **Requirements:** HTTPS or `localhost`, opened by a host name, and a browser and passkey that support PRF. A passkey belongs to a domain name, so browsers refuse it on an IP address even over HTTPS: `npm run dev:lan` opened as `https://192.168.x.x:…` cannot use the lock (Settings says so). On your own machine, open `localhost`. From another device, the server needs a host name and a certificate that device trusts (for example a local DNS name with an mkcert certificate, see [WebUI](../local/webui.md#using-it-from-other-devices-lan)); with a self-signed certificate Chrome refuses passkeys too. Current Chrome, Edge and Safari do with their built-in passkeys; with other combinations, a phone or a security key often works. FreeGent says so when the browser or passkey cannot do it.
- **The passkey belongs to this site.** A passkey made on freegent.ai does not unlock a copy of FreeGent on another address, which has its own saved keys anyway.
- **Lost the passkey?** **Forgot it…** deletes the locked keys and turns the lock off; enter your keys again. There is no other way back in. The passkey itself stays in your password manager or device until you delete it there.
- **Turn off** (while unlocked) stores the keys unencrypted again.
- With two FreeGent tabs open, each change is merged into the latest saved copy, so edits in different tabs are kept.
