# E2EE-Discord protocol

This describes the on-the-wire format, so other clients can talk to the JS plugin (the Aliucord/Android port in [`aliucord/`](aliucord/) implements it in Kotlin). It's compatible with SimpleDiscordCrypt. Reference implementation: [`src/core.js`](src/core.js). The tests in [`test/`](test/) check it against an independent implementation.

Version 3.0 added the [seal](#seal) and a new [vault format](#database-export). Both are marked "3.0" below. Everything else is unchanged since SimpleDiscordCrypt.

## Primitives

| Purpose | Algorithm |
|---|---|
| Message & file encryption | AES-256-CBC, PKCS#7 padding, random 16-byte IV prepended: `IV ‖ ciphertext` |
| Key id ("key hash") | `SHA-512(rawKey)[0:16]` (16 bytes) |
| Key exchange | ECDH on P-521. Public keys are raw/uncompressed (`0x04 ‖ X ‖ Y`, 133 bytes). Shared secret = the first 256 bits of `deriveBits`, used directly as an AES-256 key |
| Payload text encoding | every byte `b` becomes the character `U+2800 + b` (braille block) |
| Seal (3.0) | HMAC-SHA-256, truncated to 16 bytes. Key: HKDF-SHA-256 of the message key |
| Database password (3.0) | PBKDF2-HMAC-SHA-512, 600,000 iterations, 16-byte salt |

## Encrypted message

```
content = PAYLOAD "\n" "-# 🔒 Encrypted with [E2EE-Discord](<https://github.com/xo907/e2ee-discord#s=SEAL>)"
PAYLOAD = braille( keyHash[16] ‖ AES(key, MESSAGE) )      // MESSAGE omitted for attachment-only messages
```

- `#s=SEAL` is the [seal](#seal). Clients before 3.0 send the same line without it.
- If the message is too long, the tag may be shortened to ` [🔒](<https://github.com/xo907/e2ee-discord#s=SEAL>)` on the same line.
- **Receivers must accept** any payload of 16 or more braille characters, followed by whitespace and a single trailing line containing `e2ee-discord` (case-insensitive). They must also accept the legacy tag `` `SimpleDiscordCrypt` ``, written either plain or in mathematical italics.
- Regex used: `^([⠀-⣿]{16,})(?:[ \t]*`(?:SimpleDiscordCrypt|𝘚𝘪𝘮𝘱𝘭𝘦𝘋𝘪𝘴𝘤𝘰𝘳𝘥𝘊𝘳𝘺𝘱𝘵)`|\s+[^\n]*e2ee-discord[^\n]*)$` (flag `i`).

### Seal

*Added in 3.0.* AES-CBC alone lets anyone who can change the stored message flip bits in the plaintext. The seal detects that.

```
macKey = HKDF-SHA-256(ikm = raw message key, salt = empty, info = "E2EE-Discord seal v1", 32 bytes)
SEAL   = base64url( HMAC-SHA-256(macKey, payloadBytes)[0:16] )      // no padding: 22 characters
```

- `payloadBytes` is everything the braille text encodes: `keyHash ‖ IV ‖ ciphertext`, or just `keyHash` for an attachment-only message.
- The seal is put in the fragment of the tag's link, so clients that don't know it still match the tag line and decrypt as before.
- Receivers find it with `e2ee-discord#s=([A-Za-z0-9_-]{22})(?![A-Za-z0-9_-])` (flag `i`) in the text after the payload.
  - **Seal present and correct:** show the message.
  - **Seal present and wrong:** do not show the message or open its attachments.
  - **No seal:** the message is from an older client. Show it. A client may let the user mark such messages (the reference client's per-channel `q` setting).
- Senders should always add a seal. If the message would exceed Discord's length limit only because of it, send without.
- A seal authenticates the payload to holders of the key. It does not identify the sender within a group, and it does not cover attachments.

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
- `channels`: `{ [channelId]: { k, e, l, d, s?, w?, q? } }`. `q: 1` marks unsealed messages in that channel (3.0).
- `personalKeyHash`, `dhPublicKey` (raw, base64), `dhPrivateKey` (PKCS#8, base64, possibly encrypted).
- `isEncrypted`: whether the database has a password. If so, one of these two formats describes it:
  - **3.0:** `kdf: "PBKDF2-SHA512"`, `kdfIterations` (600000), `kdfSalt` (16 bytes, base64), `dbPasswordHash`.
    `out = PBKDF2-HMAC-SHA-512(utf8(password), kdfSalt, kdfIterations, 48 bytes)`. The database key is `out[0:32]`, and the password is right if `base64(out[32:48])` equals `dbPasswordHash`.
  - **Before 3.0** (no `kdf` field): `dbPasswordSalt`, `dbKeySalt` (numbers), `dbPasswordHash`. The password is checked with `base64(SHA-512(password + salt)[0:16])`, and the database key is `SHA-512(password + keySalt)[0:32]`. Clients must still read this format, and should rewrite the database in the 3.0 format once it is unlocked.
  - A client that meets a `kdf` value it doesn't know must refuse the database rather than guess.
- `autoKeyExchange`, `trustedKeys`, `keyRotators`, `pingOn`, `isSecondary`.
- `autoLock` (minutes, absent = off) and `seenVersion` are settings of the reference client (3.0).
