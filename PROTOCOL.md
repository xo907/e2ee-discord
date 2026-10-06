# E2EE-Discord protocol

This describes the on-the-wire format, so other clients can talk to the JS plugin (the Aliucord/Android port in [`aliucord/`](aliucord/) implements it in Kotlin). It's compatible with SimpleDiscordCrypt. Reference implementation: [`src/core.js`](src/core.js).

## Primitives

| Purpose | Algorithm |
|---|---|
| Message & file encryption | AES-256-CBC, PKCS#7 padding, random 16-byte IV prepended: `IV ‖ ciphertext` |
| Key id ("key hash") | `SHA-512(rawKey)[0:16]` (16 bytes) |
| Key exchange | ECDH on P-521. Public keys are raw/uncompressed (`0x04 ‖ X ‖ Y`, 133 bytes). Shared secret = the first 256 bits of `deriveBits`, used directly as an AES-256 key |
| Payload text encoding | every byte `b` becomes the character `U+2800 + b` (braille block) |

## Encrypted message

```
content = PAYLOAD "\n" "-# 🔒 Encrypted with [E2EE-Discord](<https://github.com/xo907/e2ee-discord>)"
PAYLOAD = braille( keyHash[16] ‖ AES(key, MESSAGE) )      // MESSAGE omitted for attachment-only messages
```

- If the message is too long, the tag may be shortened to ` [🔒](<https://github.com/xo907/e2ee-discord>)` on the same line.
- **Receivers must accept** any payload of 16 or more braille characters, followed by whitespace and a single trailing line containing `e2ee-discord` (case-insensitive). They must also accept the legacy tag `` `SimpleDiscordCrypt` ``, written either plain or in mathematical italics.
- Regex used: `^([⠀-⣿]{16,})(?:[ \t]*`(?:SimpleDiscordCrypt|𝘚𝘪𝘮𝘱𝘭𝘦𝘋𝘪𝘴𝘤𝘰𝘳𝘥𝘊𝘳𝘺𝘱𝘵)`|\s+[^\n]*e2ee-discord[^\n]*)$` (flag `i`).

### MESSAGE (plaintext before encryption)

UTF-8 text. If it is **1600 bytes or more**, it is compressed:

1. Pack the bytes as 24-bit RGB pixels, three bytes per pixel, little-endian, alpha 255. Use `lines = ceil(pixels / 32767)` rows and `width = ceil(pixels / lines)` columns, padding the remainder with zero bytes.
2. Encode the result as a PNG.
3. Overwrite the first 6 bytes of the PNG: `05 DC` followed by the original byte length as a little-endian uint32.

To decompress: if the decrypted data starts with `05 DC`, restore `89 50 4E 47 0D 0A`, decode the PNG, read the RGB bytes back in order, and truncate to the stored length.

## Attachments

- The file content becomes `AES(key, fileBytes)`. Use the same key as the message's `keyHash`.
- The filename becomes `base64url(AES(key, utf8(name)))` with no padding. Regenerate it with a new IV if the result starts or ends with `_`, because Discord trims that character. Names are cut to 47 bytes (keeping the extension) or replaced with `file.<ext>`. Spoilers are expressed as a `SPOILER_` prefix inside the encrypted name.
- `png jpg jpeg gif webp avif jpe jfif` are shown inline as images, and `mp4 webm mov m4v` as videos. Everything else is offered as a download.

## Key types (database `t`)

| t | Name | Notes |
|---|---|---|
| 1 | GROUP | random 32-byte key, shared over DMs |
| 2 | CONVERSATION | ECDH secret for one DM |
| 3 | PERSONAL | random 32-byte key per user, handed to DM partners during the exchange |

## System messages (DM only)

```
"```ml\n-----SYSTEM MESSAGE-----\n```" BODY "\n-# 🔑 E2EE-Discord key exchange · [what is this?](<https://github.com/xo907/e2ee-discord>)"
BODY = lines of  *name*: `value`        (values that are bytes use the braille encoding)
```

Legacy footer: a ```` ```yaml\n𝘚𝘪𝘮𝘱𝘭𝘦𝘋𝘪𝘴𝘤𝘰𝘳𝘥𝘊𝘳𝘺𝘱𝘵\n``` ```` code block.

| `type` | Fields | Meaning / response |
|---|---|---|
| `DH KEY` | `dhKey` | Sender's public key. The receiver derives the secret, stores it as a CONVERSATION key, uses it for the DM, and replies with `DH RESPONSE` |
| `DH RESPONSE` | `dhKey`, `personalKey` = AES(secret, myPersonalKey) | The initiator derives the secret, stores the peer's personal key, and replies with `PERSONAL KEY` |
| `PERSONAL KEY` | `key` = hash of the DM key, `personalKey` = AES(dmKey, myPersonalKey) | Completes the exchange |
| `KEY REQUEST` | `requestedKey` = keyHash | Asks the peer to share a key |
| `KEY SHARE` | `status` (`OK`, `DENIED`, `NOT FOUND`), `key` = hash of the DM key, `sharedKey` = AES(dmKey, raw key), `keyType`, `keyDescriptor`, optional `keyHidden: YES`, `sharedChannels` = JSON array of up to 20 channel ids | Delivers a key |

Clients must ignore system messages older than the newest one they have already processed in that DM. They must also ask the user before acting on exchanges from people who aren't trusted.

## Database export

JSON, optionally compressed with the PNG scheme above (`.dat`). Fields:

- `keys`: `{ [keyHashBase64]: { k, t, d, r, l, h } }`. `k` is the raw key in base64. If `isEncrypted` is set, it is AES-encrypted with the database key.
- `channels`: `{ [channelId]: { k, e, l, d, s?, w? } }`
- `personalKeyHash`, `dhPublicKey` (raw, base64), `dhPrivateKey` (PKCS#8, base64, possibly encrypted).
- `isEncrypted`, `dbPasswordSalt`, `dbKeySalt`, `dbPasswordHash`. The password is checked with `base64(SHA-512(password + salt)[0:16])`. The database key is `SHA-512(password + keySalt)[0:32]`.
- `autoKeyExchange`, `trustedKeys`, `keyRotators`, `pingOn`, `isSecondary`.
