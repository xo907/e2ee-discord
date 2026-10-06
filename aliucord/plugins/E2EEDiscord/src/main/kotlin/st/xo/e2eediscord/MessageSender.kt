/*
 * E2EE-Discord for Aliucord — Made by XO.ST
 * https://github.com/xo907/e2ee-discord
 * SPDX-License-Identifier: LGPL-3.0-or-later
 */

package st.xo.e2eediscord

import java.util.concurrent.ConcurrentHashMap

/** Decides whether an outgoing message is encrypted, and encrypts it. */
internal class MessageSender(private val database: KeyDatabase) {
    sealed class Outcome {
        /** Send unchanged */
        object Plain : Outcome()

        /** Send with this content instead */
        class Replace(val content: String) : Outcome()

        /** Don't send at all: sending would leak plaintext or can't be done safely */
        class Blocked(val reason: String) : Outcome()
    }

    sealed class Decision {
        /** Not encrypted, send as is */
        object Plain : Decision()

        /** Not encrypted, but a NOENC prefix has to be removed */
        class PlainBody(val body: String) : Decision()

        class Encrypt(val keyHash: String, val key: ByteArray, val body: String) : Decision()

        class Blocked(val reason: String) : Decision()
    }

    /** The files of a message being sent */
    sealed class Files {
        object None : Files()

        /** Attached as they are */
        object Plain : Files()

        /** Encrypted by [AttachmentEncryptor] with this key */
        class Encrypted(val keyHash: String) : Files()
    }

    /** Messages being edited that were encrypted, and the key they used: the edit is always encrypted with it */
    val editKeys = ConcurrentHashMap<Long, String>()

    /** Nonces of queued messages whose files were encrypted, and the key used */
    val encryptedUploads: MutableMap<String, String> = java.util.Collections.synchronizedMap(
        object : LinkedHashMap<String, String>() {
            override fun removeEldestEntry(eldest: MutableMap.MutableEntry<String, String>?) = size > 200
        },
    )

    private fun <V> recentMap(): MutableMap<String, V> = java.util.Collections.synchronizedMap(
        object : LinkedHashMap<String, V>() {
            override fun removeEldestEntry(eldest: MutableMap.MutableEntry<String, V>?) = size > 200
        },
    )

    /** Nonces of queued messages and their channel, recorded when Discord starts sending them */
    val queuedChannels: MutableMap<String, Long> = recentMap()

    /** Nonces of messages whose text was already prepared (and the result), so later hooks leave them alone */
    val prepared: MutableMap<String, String> = recentMap()

    fun decide(channelId: Long, content: String?, editingMessageId: Long? = null): Decision {
        val text = content.orEmpty()
        // key-exchange messages are sent as is
        if (text.startsWith("```") && Protocol.systemMessagePattern.matcher(text).matches()) return Decision.Plain
        // already encrypted (e.g. Discord retrying a failed send)
        if (text.isNotEmpty() && text[0] in '⠀'..'⣿' && Protocol.messagePattern.matcher(text).matches())
            return Decision.Plain

        val forcedKey = editingMessageId?.let { editKeys[it] }
        var body = text
        val prefix = Protocol.encryptPrefix.matcher(text)
        val hasPrefix = prefix.lookingAt()
        if (hasPrefix) body = text.substring(prefix.end())

        if (forcedKey == null) {
            if (!hasPrefix && !database.isChannelEncrypted(channelId)) return Decision.Plain
            val noEncrypt = Protocol.noEncryptPrefix.matcher(body)
            if (noEncrypt.lookingAt()) return Decision.PlainBody(body.substring(noEncrypt.end()))
        }

        if (!database.isLoaded) return Decision.Blocked("Import your E2EE-Discord key database first (Settings → Plugins → E2EEDiscord)")
        val keyHash = forcedKey ?: database.channelKeyHash(channelId)
            ?: return Decision.Blocked("No encryption key is selected for this channel")
        return when (val lookup = database.getKey(keyHash)) {
            is KeyLookup.Found -> Decision.Encrypt(keyHash, lookup.key, body)
            KeyLookup.Locked -> Decision.Blocked("E2EE-Discord is locked — unlock it in Settings → Plugins → E2EEDiscord")
            else -> Decision.Blocked("The key for this channel isn't on this phone. Re-import your database from desktop.")
        }
    }

    fun prepare(channelId: Long, content: String?, editingMessageId: Long? = null, files: Files = Files.None): Outcome {
        val decision = decide(channelId, content, editingMessageId)

        if (files is Files.Encrypted) {
            // already done (Discord retrying a send)
            val text = content.orEmpty()
            if (text.isNotEmpty() && text[0] in '⠀'..'⣿' && Protocol.messagePattern.matcher(text).matches()) return Outcome.Plain
            // the text has to carry the files' key, or nobody can open them
            val body = when (decision) {
                is Decision.Encrypt -> decision.body
                is Decision.PlainBody -> decision.body
                else -> content.orEmpty()
            }
            val key = (database.getKey(files.keyHash) as? KeyLookup.Found)?.key
                ?: return Outcome.Blocked("The files' encryption key is no longer available, so nothing was sent")
            return Outcome.Replace(Protocol.encryptMessage(files.keyHash, key, body))
        }

        return when (decision) {
            Decision.Plain -> Outcome.Plain
            is Decision.PlainBody -> Outcome.Replace(decision.body)
            is Decision.Blocked -> Outcome.Blocked(decision.reason)
            is Decision.Encrypt ->
                if (files == Files.Plain) {
                    Outcome.Blocked("The attached files couldn't be encrypted, so nothing was sent. Use /e2ee off to send them unencrypted.")
                } else {
                    Outcome.Replace(Protocol.encryptMessage(decision.keyHash, decision.key, decision.body))
                }
        }
    }
}
