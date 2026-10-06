<h1 align="center">
    <img src="assets/logo-128.png" height="64" width="64" alt=""><br>
    E2EE-Discord
</h1>
<p align="center"><b>End-to-end encryption for Discord messages and files.</b><br>Made by <b>XO.ST</b> · <a href="https://github.com/xo907/e2ee-discord">github.com/xo907/e2ee-discord</a></p>

---

E2EE-Discord encrypts your messages and attachments **in your client** before they reach Discord, and decrypts them for everyone else who has the plugin and the key. Keys are exchanged automatically over DMs (ECDH P-521), and messages are encrypted with AES-256.

People without the plugin see a block of braille-like characters with a small link back to this page.

> E2EE-Discord is a revived, modernised fork of [SimpleDiscordCrypt](https://gitlab.com/An0/SimpleDiscordCrypt) by An0, which was abandoned. It reads SimpleDiscordCrypt messages and databases, so existing keys keep working.

## Install

| Where | How |
|---|---|
| **Desktop app (recommended)** | One-click [Vencord](https://vencord.dev) installer — see [Vencord](#vencord) |
| **Chrome / Edge / Brave / Opera** | Browser extension — see [Extension](#browser-extension) |
| **Firefox 128+** | Same extension (load `extension/manifest.json` as a temporary add-on), or the userscript |
| **Any browser** | Userscript: install [Tampermonkey](https://www.tampermonkey.net/) or [Violentmonkey](https://violentmonkey.github.io/), then open [`dist/E2EE-Discord.user.js`](dist/E2EE-Discord.user.js) |
| **BetterDiscord** | Copy [`betterdiscord/E2EEDiscord.plugin.js`](betterdiscord/E2EEDiscord.plugin.js) into your plugins folder |
| **Android** | [Aliucord](https://github.com/Aliucord/Aliucord) plugin: read, send and edit encrypted messages, key exchange, encrypted files and media — see [aliucord/README.md](aliucord/README.md) |

Only install it from this repository.

### Vencord

Vencord can only run custom plugins that are compiled into it. The installer does that for you: it installs git, Node.js and pnpm if needed (asking first), downloads Vencord, adds E2EE-Discord, builds it, injects it into Discord, turns the plugin on and restarts Discord.

**Windows:** download and double-click [`Install-E2EE-Discord.cmd`](Install-E2EE-Discord.cmd). Or run this in PowerShell:

```powershell
irm https://raw.githubusercontent.com/xo907/e2ee-discord/main/install-vencord.ps1 -OutFile $env:TEMP\e2ee.ps1; powershell -ExecutionPolicy Bypass -File $env:TEMP\e2ee.ps1
```

**macOS / Linux:**

```bash
curl -fsSL https://raw.githubusercontent.com/xo907/e2ee-discord/main/install-vencord.sh | bash
```

- **Update:** run the installer again. It updates Vencord and E2EE-Discord together.
- **Discord PTB or Canary:** add `-Branch ptb` / `--branch canary`. The default `auto` picks the first install it finds.
- **Uninstall:** `Install-E2EE-Discord.cmd -Uninstall` or `bash install-vencord.sh --uninstall`. Export your key database first.
- Vencord is kept in `%LOCALAPPDATA%\E2EE-Discord` (Windows), `~/Library/Application Support/E2EE-Discord` (macOS) or `~/.local/share/e2ee-discord` (Linux). **Don't delete that folder** while Vencord is installed; Discord loads Vencord from it.
- When Discord updates itself it can remove Vencord. Just run the installer again.

**Manual install:** copy `vencord/e2eeDiscord` into `Vencord/src/userplugins/`, then run `pnpm build` and `pnpm inject` ([guide](https://docs.vencord.dev/installing/custom-plugins/)). The same folder works in Vencord forks such as Equicord.

### Browser extension

1. Download `dist/E2EE-Discord-extension-<version>.zip` and unzip it (or use the `extension` folder directly).
2. Open `chrome://extensions`, turn on **Developer mode**, click **Load unpacked** and pick the folder.

## Using it

- **Click the lock** in the chat bar to turn encryption on or off for the current channel. The input gets a red outline when it's on.
- **Right-click the lock**, or click the key chip in the channel header, to open the menu: pick the channel key, start a key exchange, share keys, or manage keys, channels and your database.
- **DMs:** a key exchange happens automatically the first time you need one. By default E2EE-Discord **asks before sending** anything. Turn on *Auto key exchange with friends* in the menu to skip the prompt for friends.
- **Group channels:** use *Create Group Key* in a server channel, then share it from a DM with *Share Keys*.
- **Files** you attach in an encrypted channel are encrypted, filenames included. When decrypted, they show inline:
  - images and GIFs, including Discord's zoomable viewer;
  - videos, with a play button;
  - audio and music, in Discord's audio player.

  Click any other file to decrypt and download it. Middle-click media to save it.
- **Prefixes:** start a message with `ENC` to encrypt one message, or `NOENC` to send one in plain text.
- Decrypted messages start with a **red lock**. A **white lock** means the message used a different key than the one selected for the channel; hover over it to see which key.

### Database

Your keys live in a local database, optionally protected with a password. **Export it regularly** (menu → *Export Database*).

To use E2EE-Discord on more than one device, export from your main device and import on the others as **Secondary**. If you used SimpleDiscordCrypt before, your database is picked up automatically when possible; otherwise import your old `.dat`/`.json` export.

### Key verification

Open a DM and choose *Visualize Key*. Both of you should see the same picture. If you do, mark the key as trusted.

### Console helpers

These are available in DevTools (`Ctrl+Shift+I`). The old `Sdc…` names still work.

```js
E2EESetPingOn(/\bmy name\b/i)    // extra notifications for decrypted messages that match
E2EESetKeyRotation(7)            // rotate the current channel's group key every 7 days
E2EEClearKeys(k => k.lastseen < Date.now() - 180 * 864e5)       // delete keys unused for 6 months
E2EEClearChannels(c => c.lastseen < Date.now() - 180 * 864e5)
```

## Security notes

- Messages: AES-256-CBC. Key exchange: ECDH P-521. Everything uses the browser's Web Crypto API.
- Discord can still see **who** you talk to, **when**, and roughly **how long** each message is.
- Key exchanges are only as trustworthy as the first exchange. Compare keys with *Visualize Key*.
- The database password is checked with a salted SHA-512 hash. Pick a strong password if your device could be accessed by others.
- Client mods and userscripts break Discord's Terms of Service. Use at your own risk.

## Development

Everything is built from one file, [`src/core.js`](src/core.js). Each platform only adds a small wrapper from `src/hosts/`.

```powershell
powershell -ExecutionPolicy Bypass -File build.ps1      # builds dist/, extension/, vencord/, betterdiscord/
powershell -ExecutionPolicy Bypass -File scripts\make-icons.ps1
```

The core is written to survive Discord updates:

- It searches every webpack runtime Discord loads (there are several) and skips proxy modules.
- It finds stores by name first, then by the methods they expose.
- It scans message events by shape instead of hard-coding payloads, so new events such as pins, search, threads and forwards are handled.
- It places the UI with prefix-only class selectors and falls back to a floating button.
- Optional pieces degrade with a console warning instead of breaking the plugin.

If something stops working after a Discord update, check the console for `[E2EE-Discord]` messages.

## License

[GNU LGPL v3](LICENSE). Based on SimpleDiscordCrypt © An0, see [NOTICE](NOTICE).
