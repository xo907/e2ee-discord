# Privacy Policy — E2EE-Discord

Effective date: October 5, 2026

E2EE-Discord ("the plugin") is made by XO.ST. It runs entirely in your Discord client.

## What we collect

Nothing. The plugin has no servers, analytics or telemetry.

## What the plugin stores

On your own device, the plugin stores your encryption keys and per-channel settings. Depending on how you installed it, they live in the extension's storage, your userscript manager's storage, Vencord's DataStore or BetterDiscord's plugin data. You can export or delete this data at any time.

## What the plugin sends

- **Encrypted messages and files** go to Discord the same way normal messages do. Discord can't read their contents.
- **Key exchange messages** contain public keys, or keys encrypted for the recipient. They are sent to the DM partner involved, after you confirm (unless you turned on automatic key exchange with friends).
- **Blacklist:** the plugin downloads a public list of servers whose owners asked not to have encryption used, from this GitHub repository. No data about you is sent in that request beyond what any web request includes.

## Contact

https://github.com/xo907/e2ee-discord/issues
