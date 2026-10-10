# E2EE-Discord for Aliucord (Android)

Made by **XO.ST** · https://github.com/xo907/e2ee-discord

An [Aliucord](https://github.com/Aliucord/Aliucord) plugin for messages encrypted by E2EE-Discord (or SimpleDiscordCrypt) on desktop. It uses the same keys, so anything you can read on your computer you can read on your phone, and it can send encrypted messages and files too.

Plugin 0.5.0 goes with E2EE-Discord 3.0 on desktop: it sends [sealed](../README.md#sealed-messages) messages, refuses altered ones, and opens databases exported from 3.0. You need 0.5.0 to import a password-protected database exported from desktop 3.0. Older exports, and messages from older versions, keep working.

## Status: phase 4

| | |
|---|---|
| ✅ Decrypt messages and reply previews | phase 1 |
| ✅ Import your desktop key database, with password unlock | phase 1 |
| ✅ Send and edit encrypted messages (`/e2ee on`) | phase 2 |
| ✅ Key exchange: DM keys, personal keys, key requests and shares | phase 3 |
| ✅ Encrypted files, images, video and audio | phase 4 |
| ✅ Sealed messages and 3.0 databases | 0.5.0 |

### Files and media

- Files you send while encryption is on are encrypted before upload, names included. Discord only sees `application/octet-stream` blobs with random-looking names.
- Encrypted images, GIFs and videos (up to 100 MB) are decrypted automatically and shown inline. Tap one to open it in Discord's viewer.
- For other files (music, documents and so on), tap the file or its download button. It is decrypted, saved to **Downloads** with its real name, and opened in another app when you tap the file itself.
- Decrypted media is kept in Discord's private cache. **Settings → Plugins → E2EEDiscord → Delete decrypted files** clears it, and removing the key database clears it too.
- If a file can't be encrypted, nothing is sent. Files are never uploaded unencrypted while encryption is on.

### Key exchange

Your phone uses the same key pair as your desktop (it comes with the imported database), so it can follow every exchange.

- **Answer key exchanges from this phone: off** (the default). Your computer answers exchanges. The phone silently learns the resulting keys, so new secure DMs and shared keys work on the phone without re-importing, and nobody gets duplicate replies.
- **Answer key exchanges from this phone: on.** Use this if you don't run E2EE-Discord on a computer. The phone answers exchanges and key requests, and asks people for keys it's missing.
- **`/e2ee exchange`** in a DM sets up a secure DM key from the phone.

Key exchanges only happen in DMs, and the other person needs E2EE-Discord too. The phone asks before replying to someone, unless they're a friend and *auto key exchange with friends* is on in your desktop menu.

### Sending

- `/e2ee on` and `/e2ee off` turn encryption on or off for the current chat. `/e2ee status` shows the current state.
- While encryption is on in the chat you have open, the message box has a **red outline** and its placeholder reads **🔒 Encrypted · key name**, like the red outline on desktop. If the database is locked, the placeholder says so instead.
- `/e2ee keys` lists your keys. `/e2ee keys key:2` switches this chat to key 2.
- Start a single message with `ENC` to encrypt just that one, or `NOENC` to send just that one unencrypted.
- Editing an encrypted message shows its plaintext and always re-encrypts it with the same key.
- If a message can't be encrypted safely (the database is locked or the key is missing), nothing is sent and a message explains why. It never falls back to plaintext.

## Install

1. Get the plugin: use `dist/E2EEDiscord-aliucord-<version>.zip` from this repository, download it from the **Actions** tab (artifact *E2EEDiscord-aliucord*), or build it yourself (see below).
2. Copy it to `Aliucord/plugins/` on your phone, rename it to `E2EEDiscord.zip`, then restart Discord.
3. In Discord on your computer, right-click the lock in the message bar → **Export Database**. Copy `E2EE-Discord.dat` to your phone's **Downloads** or **Aliucord** folder.
4. On the phone, open Settings → Plugins → **E2EEDiscord** → **Import**. If your database has a password, enter it and tap **Unlock**.
5. **Delete `E2EE-Discord.dat` from your phone's storage afterwards.** The plugin keeps its own private copy, and the exported file contains your keys.

Decrypted messages start with 🔒.

## Build

You need JDK 21 and the Android SDK (Android Studio installs both). From this folder:

```bash
./gradlew :plugins:E2EEDiscord:make            # → plugins/E2EEDiscord/build/outputs/E2EEDiscord.zip
./gradlew :plugins:E2EEDiscord:deployWithAdb   # build and push to a connected phone/emulator
```

On Windows use `gradlew.bat`. Pushes to GitHub also build it automatically through `.github/workflows/aliucord.yml`.

## How it works

The plugin hooks the chat list's text rendering and reply previews. Right before Discord draws an encrypted message, the plugin swaps the decrypted text into the message; right after, it swaps the original back. The stored message never changes, so editing, copying or quoting can't send plaintext back to Discord.

For files, the plugin swaps encrypted copies into Discord's send queue before the upload is built, then encrypts the message text with the same key. Received attachments are downloaded, decrypted into the app's cache, and the attachment is pointed at the local file, so Discord's own image and video views display it.

The wire format is described in [PROTOCOL.md](../PROTOCOL.md).
