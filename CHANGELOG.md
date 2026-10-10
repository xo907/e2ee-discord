# Changelog

## 3.0.0

Desktop (userscript, extension, Vencord, BetterDiscord) 3.0.0 · Android (Aliucord) 0.5.0

3.0 talks to 2.x and SimpleDiscordCrypt in both directions: nobody has to update at the same time. See [Updating](#updating-from-2x) for the one thing that does need care (password-protected databases).

### Sealed messages

Messages were encrypted but not authenticated. Someone who could change a message in transit or at rest (Discord, or anything between you and it) could flip bits in the ciphertext, and the plugin would decrypt and show the result as if it were genuine.

- Every message now carries a **seal**: an HMAC-SHA-256 over the encrypted payload, made with a key derived from the message key.
- A message whose seal doesn't match is **not shown**. You see "This encrypted message was altered after it was sent" instead.
- The seal travels in the link of the tag line under the message, so 2.x and SimpleDiscordCrypt clients read sealed messages exactly as before.
- Messages from those older clients have no seal and are still read. **Require sealed messages** (lock menu, per channel) flags them, for channels where everyone has updated.
- Limits: a seal proves the message came from someone who has the key and was not changed since. It does not say *which* key holder wrote it, and attached files are not sealed yet.

### Hardened key vault

The database password was checked with a single salted SHA-512, and the same construction made the key that protects your keys. Anyone who got a copy of the database (an export left in Downloads, a backup, a synced folder) could try billions of passwords per second against it.

- The password now goes through **PBKDF2-HMAC-SHA-512 with 600,000 rounds** and a 128-bit salt. Each guess costs an attacker what 600,000 guesses cost before.
- Existing databases are **upgraded automatically** the first time you unlock them. There is nothing to do, and your password stays the same.
- The unlock window checks the password in place ("Unlocking…") instead of closing and reopening.

### Lock

- **Lock now** (lock menu, or `Alt+Shift+L`): removes every key from memory and covers Discord until you enter your password.
- **Auto-lock** (lock menu): locks by itself after 5, 15 or 60 minutes without activity. Off by default.
- While locked, messages that arrive wait and are decrypted when you unlock.
- Needs a database password. Without one there is nothing to unlock with, so the menu item is disabled.

### No plain text into an encrypted channel

- While the vault is locked, and at startup while the unlock window is open, sending to a channel that has encryption on is **refused** with a notice. Before, a message typed during that time went out unencrypted.
- The same applies to file uploads and to the `ENC` prefix.

### Android (Aliucord 0.5.0)

- **Encryption indicator**: while encryption is on in the open chat, the message box has a red outline and its placeholder shows a lock and the key in use.
- Sends sealed messages and refuses altered ones, including their files.
- Opens databases exported from 3.0 (PBKDF2). Older exports still work.
- Unlocking no longer freezes the settings page while the password is checked.

### For developers

- **Tests**: `npm test` runs the real core in Node against a fake Discord. Two clients do a full key exchange, exchange sealed messages, share a group key, lock and unlock. Seals and the vault are checked against an independent implementation (`node:crypto`). No dependencies.
- **Playground**: `test/playground.html` runs the core in a pretend Discord, to try the interface and see what goes over the wire without an account.
- **CI** runs the tests on every push.
- [PROTOCOL.md](PROTOCOL.md) documents the seal and the new vault format.
- Fixed: a 10-second timer was left running for every processed message.

### Updating from 2.x

- **Messages**: nothing to do. Old and new clients read each other.
- **Database with a password**: once 3.0 has unlocked it, it is in the new format, and exports made from then on can only be opened by 3.0 (desktop) and 0.5.0 (Android). Update your other devices before importing a new export on them. An export made by 2.x still imports everywhere.
- **Database without a password**: unchanged.
