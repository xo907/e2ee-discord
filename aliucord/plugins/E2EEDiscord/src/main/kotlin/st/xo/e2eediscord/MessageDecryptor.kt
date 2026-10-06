/*
 * E2EE-Discord for Aliucord — Made by XO.ST
 * https://github.com/xo907/e2ee-discord
 * SPDX-License-Identifier: LGPL-3.0-or-later
 */

package st.xo.e2eediscord

import com.aliucord.Logger

/** Turns encrypted message content into the text shown in chat. */
internal class MessageDecryptor(private val database: KeyDatabase, private val logger: Logger) {
    companion object {
        const val DECRYPTED_PREFIX = "🔒 "
        const val UNLOCK_HINT = "🔒 *Encrypted message* — unlock E2EE-Discord in Settings → Plugins → E2EEDiscord"
        const val NO_DATABASE_HINT = "🔒 *Encrypted message* — import your E2EE-Discord key database in Settings → Plugins → E2EEDiscord"
        const val MISSING_KEY_HINT = "🔒 *Encrypted message* — this phone doesn't have the key yet. It's requested automatically when \"answer key exchanges\" is on; otherwise re-import your database from desktop."
        const val INVALID_HINT = "⚠️ *Encrypted message in an unknown format*"
        const val SYSTEM_MESSAGE_HINT = "🔑 *E2EE-Discord key exchange*"

        private const val CACHE_SIZE = 500
    }

    // content -> rendered text, for the current database version
    private val cache = object : LinkedHashMap<String, String>(64, 0.75f, true) {
        override fun removeEldestEntry(eldest: MutableMap.MutableEntry<String, String>?) = size > CACHE_SIZE
    }
    private var cacheVersion = -1

    /** @return the text to display instead of [content], or null if it isn't an E2EE-Discord message */
    @Synchronized
    fun display(content: String?): String? {
        if (content.isNullOrEmpty()) return null
        val first = content[0]
        val maybePayload = first in '⠀'..'⣿'
        if (!maybePayload && !content.startsWith("```")) return null

        if (cacheVersion != database.version) {
            cache.clear()
            cacheVersion = database.version
        }
        cache[content]?.let { return it }

        val result = if (maybePayload) {
            val matcher = Protocol.messagePattern.matcher(content)
            if (!matcher.matches()) return null
            decrypt(matcher.group(1)!!)
        } else {
            if (!Protocol.systemMessagePattern.matcher(content).matches()) return null
            SYSTEM_MESSAGE_HINT
        }

        cache[content] = result
        return result
    }

    /** The id of the key an encrypted message needs, or null */
    fun keyHashOf(content: String?): String? {
        if (content.isNullOrEmpty() || content[0] !in '⠀'..'⣿') return null
        val matcher = Protocol.messagePattern.matcher(content)
        if (!matcher.matches()) return null
        val bytes = Protocol.payloadDecode(matcher.group(1)!!)
        return if (bytes.size < 16) null else Protocol.base64(bytes.copyOf(16))
    }

    class Plaintext(val keyHash: String, val text: String)

    /** The decrypted text of an encrypted message (no prefix), for editing; null if it can't be decrypted */
    fun plaintextFor(content: String?): Plaintext? {
        if (content.isNullOrEmpty() || content[0] !in '⠀'..'⣿') return null
        val matcher = Protocol.messagePattern.matcher(content)
        if (!matcher.matches()) return null
        val bytes = Protocol.payloadDecode(matcher.group(1)!!)
        if (bytes.size < 16) return null
        val keyHash = Protocol.base64(bytes.copyOf(16))
        val key = (database.getKey(keyHash) as? KeyLookup.Found)?.key ?: return null
        if (bytes.size == 16) return Plaintext(keyHash, "")
        return try {
            val plain = Protocol.tryDecompress(Protocol.aesDecrypt(key, bytes.copyOfRange(16, bytes.size)))
            Plaintext(keyHash, String(plain, Charsets.UTF_8))
        } catch (e: Throwable) {
            null
        }
    }

    /** The key an encrypted message (and therefore its attachments) uses, or null if it isn't encrypted or the key is unavailable */
    fun keyFor(content: String?): ByteArray? {
        if (content.isNullOrEmpty() || content[0] !in '⠀'..'⣿') return null
        val matcher = Protocol.messagePattern.matcher(content)
        if (!matcher.matches()) return null
        val bytes = Protocol.payloadDecode(matcher.group(1)!!)
        if (bytes.size < 16) return null
        return try {
            (database.getKey(Protocol.base64(bytes.copyOf(16))) as? KeyLookup.Found)?.key
        } catch (e: Throwable) {
            null
        }
    }

    private fun decrypt(payload: String): String {
        val bytes = Protocol.payloadDecode(payload)
        if (bytes.size < 16) return INVALID_HINT
        val keyHash = Protocol.base64(bytes.copyOf(16))

        val key = try {
            database.getKey(keyHash)
        } catch (e: Throwable) {
            logger.error("Couldn't read key $keyHash", e)
            return INVALID_HINT
        }

        return when (key) {
            KeyLookup.NoDatabase -> NO_DATABASE_HINT
            KeyLookup.Locked -> UNLOCK_HINT
            KeyLookup.Missing -> MISSING_KEY_HINT
            is KeyLookup.Found -> {
                // a bare key hash marks an attachment-only message
                if (bytes.size == 16) return DECRYPTED_PREFIX.trimEnd()
                try {
                    val plain = Protocol.tryDecompress(Protocol.aesDecrypt(key.key, bytes.copyOfRange(16, bytes.size)))
                    val text = String(plain, Charsets.UTF_8)
                    // 0.4.3 on Android could encrypt an already-encrypted message (sometimes with
                    // the 🔒 display prefix in front): unwrap one extra layer
                    val inner = text.removePrefix(DECRYPTED_PREFIX).removePrefix(DECRYPTED_PREFIX.trimEnd())
                    val nested = if (inner.isNotEmpty() && inner[0] in '⠀'..'⣿') Protocol.messagePattern.matcher(inner) else null
                    if (nested != null && nested.matches()) decrypt(nested.group(1)!!) else DECRYPTED_PREFIX + text
                } catch (e: Throwable) {
                    logger.error("Couldn't decrypt a message", e)
                    INVALID_HINT
                }
            }
        }
    }
}
