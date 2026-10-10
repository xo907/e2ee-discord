/*
 * E2EE-Discord for Aliucord — Made by XO.ST
 * https://github.com/xo907/e2ee-discord
 * SPDX-License-Identifier: LGPL-3.0-or-later
 */

package st.xo.e2eediscord

import org.json.JSONObject
import java.io.File

internal sealed class KeyLookup {
    object NoDatabase : KeyLookup()
    object Locked : KeyLookup()
    object Missing : KeyLookup()
    class Found(val key: ByteArray) : KeyLookup()
}

/**
 * The key database exported from the desktop plugin (Export Database → .dat or .json).
 *
 * It is copied into Discord's private app storage, never into /sdcard, because an unprotected
 * database contains every key in plain base64. If it has a password, keys stay encrypted at rest
 * and are only decrypted in memory after [unlock].
 */
internal class KeyDatabase(privateDir: File) {
    private val file = File(privateDir, "e2ee-discord/database.json")
    private var json: JSONObject? = null
    private var dbKey: ByteArray? = null
    private val keyCache = HashMap<String, ByteArray>()

    /** Changes whenever keys become (un)available, so cached message renders can be invalidated */
    @Volatile
    var version = 0
        private set

    val isLoaded get() = json != null
    val isEncrypted get() = json?.optBoolean("isEncrypted", false) == true
    val isUnlocked get() = isLoaded && (!isEncrypted || dbKey != null)
    val keyCount get() = json?.optJSONObject("keys")?.length() ?: 0
    val isSecondary get() = json?.optBoolean("isSecondary", false) == true

    @Synchronized
    fun load() {
        json = if (file.exists()) JSONObject(file.readText(Charsets.UTF_8)) else null
        reset()
    }

    /** Reads an exported database (.dat is the PNG-compressed form, .json is plain) and stores a private copy. */
    @Synchronized
    fun import(source: File) {
        val raw = source.readBytes()
        val text = String(Protocol.tryDecompress(raw), Charsets.UTF_8)
        val parsed = JSONObject(text)
        require(parsed.optJSONObject("keys") != null) { "this file is not an E2EE-Discord database" }
        // this device only reads for now; mark it secondary like the desktop "Secondary" import
        parsed.put("isSecondary", true)

        file.parentFile?.mkdirs()
        file.writeText(parsed.toString(), Charsets.UTF_8)
        json = parsed
        reset()
    }

    /**
     * Not synchronized as a whole: a 3.0 vault's PBKDF2 takes a second or two, and message rendering
     * (which reads keys under the same lock) must not wait for it. Call it off the main thread.
     */
    fun unlock(password: String): Boolean {
        val db = synchronized(this) { json } ?: return false
        if (!db.optBoolean("isEncrypted", false)) return true
        if (password.isEmpty()) return false

        val key = (if (db.has("kdf")) vaultKey(db, password) else legacyVaultKey(db, password)) ?: return false
        synchronized(this) {
            dbKey = key
            keyCache.clear()
            version++
        }
        return true
    }

    /** Desktop 3.0 databases: PBKDF2-HMAC-SHA-512 gives the database key (32 bytes) ‖ a password check (16 bytes) */
    private fun vaultKey(db: JSONObject, password: String): ByteArray? {
        val iterations = db.optInt("kdfIterations")
        if (db.optString("kdf") != "PBKDF2-SHA512" || iterations < 1) {
            throw IllegalStateException("This database was made by a newer E2EE-Discord. Update the plugin.")
        }
        val derived = Protocol.pbkdf2Sha512(
            password.toByteArray(Charsets.UTF_8),
            Protocol.fromBase64(db.optString("kdfSalt")),
            iterations,
            48,
        )
        if (Protocol.base64(derived.copyOfRange(32, 48)) != db.optString("dbPasswordHash")) return null
        return derived.copyOf(32)
    }

    /** 2.x and SimpleDiscordCrypt databases: salted SHA-512 */
    private fun legacyVaultKey(db: JSONObject, password: String): ByteArray? {
        val passwordHash = Protocol.base64(
            Protocol.sha512((password + db.opt("dbPasswordSalt")?.toString()).toByteArray(Charsets.UTF_8)).copyOf(16),
        )
        if (passwordHash != db.optString("dbPasswordHash")) return null
        return Protocol.sha512((password + db.opt("dbKeySalt")?.toString()).toByteArray(Charsets.UTF_8)).copyOf(32)
    }

    @Synchronized
    fun lock() {
        dbKey = null
        reset()
    }

    @Synchronized
    fun delete() {
        file.delete()
        json = null
        dbKey = null
        reset()
    }

    @Synchronized
    fun getKey(keyHash: String): KeyLookup {
        keyCache[keyHash]?.let { return KeyLookup.Found(it) }
        val db = json ?: return KeyLookup.NoDatabase
        val entry = db.optJSONObject("keys")?.optJSONObject(keyHash) ?: return KeyLookup.Missing
        if (isEncrypted && dbKey == null) return KeyLookup.Locked

        var raw = Protocol.fromBase64(entry.getString("k"))
        if (isEncrypted) raw = Protocol.aesDecrypt(dbKey!!, raw)
        keyCache[keyHash] = raw
        return KeyLookup.Found(raw)
    }

    class KeyInfo(val hash: String, val type: Int, val name: String, val hidden: Boolean)

    val personalKeyHash: String? get() = json?.optString("personalKeyHash")?.takeIf { it.isNotEmpty() }

    /** Keys that can be selected for a channel (personal + group keys, same rules as the desktop key selector) */
    @Synchronized
    fun selectableKeys(currentHash: String?): List<KeyInfo> {
        val keys = json?.optJSONObject("keys") ?: return emptyList()
        val result = ArrayList<KeyInfo>()
        val names = keys.keys()
        while (names.hasNext()) {
            val hash = names.next()
            val entry = keys.optJSONObject(hash) ?: continue
            val info = KeyInfo(hash, entry.optInt("t"), entry.optString("d"), entry.optInt("h") != 0)
            val selectable = hash == personalKeyHash || hash == currentHash || (info.type == 1 && !info.hidden)
            if (selectable) result.add(info)
        }
        return result.sortedWith(compareBy({ it.hash != personalKeyHash }, { it.name.lowercase() }))
    }

    @Synchronized
    fun keyName(hash: String): String? = json?.optJSONObject("keys")?.optJSONObject(hash)?.optString("d")

    @Synchronized
    fun keyType(hash: String): Int = json?.optJSONObject("keys")?.optJSONObject(hash)?.optInt("t") ?: 0

    /** Per-channel settings: { k: key hash, e: 1 if encryption is on, l: last seen, d: descriptor } */
    @Synchronized
    fun channelKeyHash(channelId: Long): String? =
        json?.optJSONObject("channels")?.optJSONObject(channelId.toString())?.optString("k")?.takeIf { it.isNotEmpty() }
            ?: personalKeyHash

    @Synchronized
    fun isChannelEncrypted(channelId: Long): Boolean =
        json?.optJSONObject("channels")?.optJSONObject(channelId.toString())?.optInt("e") == 1

    @Synchronized
    fun setChannelEncrypted(channelId: Long, encrypted: Boolean) {
        channelConfig(channelId)?.put("e", if (encrypted) 1 else 0)
        save()
    }

    @Synchronized
    fun setChannelKey(channelId: Long, keyHash: String) {
        channelConfig(channelId)?.put("k", keyHash)
        save()
    }

    /* ───────────── key exchange support ───────────── */

    /** Our ECDH public key (raw uncompressed P-521 point) */
    @Synchronized
    fun dhPublicKey(): ByteArray? = json?.optString("dhPublicKey")?.takeIf { it.isNotEmpty() }?.let(Protocol::fromBase64)

    /** Our ECDH private key: PKCS#8 bytes, or JWK JSON if [dhPrivateKeyIsJwk]; needs the database unlocked */
    @Synchronized
    fun dhPrivateKey(): ByteArray? {
        val db = json ?: return null
        var bytes = db.optString("dhPrivateKey").takeIf { it.isNotEmpty() }?.let(Protocol::fromBase64) ?: return null
        if (isEncrypted) bytes = Protocol.aesDecrypt(dbKey ?: return null, bytes)
        return bytes
    }

    val dhPrivateKeyIsJwk: Boolean get() = json?.optBoolean("dhPrivateKeyFallback", false) == true

    /** Stores a key (wrapped with the database key if the database has a password) and returns its hash */
    @Synchronized
    fun saveKey(raw: ByteArray, type: Int, descriptor: String, hidden: Boolean = false): String {
        val db = json ?: throw IllegalStateException("no database")
        val hash = Protocol.keyHash(raw)
        val keys = db.optJSONObject("keys") ?: JSONObject().also { db.put("keys", it) }
        if (keys.has(hash)) return hash
        if (isEncrypted && dbKey == null) throw IllegalStateException("database is locked")
        val stored = if (isEncrypted) Protocol.aesEncrypt(dbKey!!, raw) else raw
        val now = System.currentTimeMillis()
        keys.put(
            hash,
            JSONObject().apply {
                put("t", type)
                put("d", descriptor.replace("`", "").replace("\n", " ").take(250))
                put("r", now)
                put("l", now)
                put("h", if (hidden || type > 1) 1 else 0)
                put("k", Protocol.base64(stored))
            },
        )
        save()
        reset()
        return hash
    }

    @Synchronized
    fun isKeyHidden(hash: String): Boolean = json?.optJSONObject("keys")?.optJSONObject(hash)?.optInt("h") == 1

    @Synchronized
    fun isKeyTrusted(hash: String?): Boolean = hash != null && json?.optJSONObject("trustedKeys")?.optInt(hash) == 1

    @Synchronized
    fun autoKeyExchangeWithFriends(): Boolean = json?.optString("autoKeyExchange")?.contains("friend", ignoreCase = true) == true

    @Synchronized
    fun hasChannelConfig(channelId: Long): Boolean = json?.optJSONObject("channels")?.has(channelId.toString()) == true

    /** Time of the newest key-exchange message handled in a DM; older ones are ignored */
    @Synchronized
    fun channelSystemTime(channelId: Long): Long =
        json?.optJSONObject("channels")?.optJSONObject(channelId.toString())?.optLong("s", 0L) ?: 0L

    @Synchronized
    fun setChannelSystemTime(channelId: Long, time: Long) {
        channelConfig(channelId)?.put("s", time)
        save()
    }

    /** Non-DM channels that use a key (shared along with group keys so the receiver can pick it automatically) */
    @Synchronized
    fun channelsUsingKey(hash: String): List<Long> {
        val channels = json?.optJSONObject("channels") ?: return emptyList()
        val result = ArrayList<Long>()
        val ids = channels.keys()
        while (ids.hasNext()) {
            val id = ids.next()
            if (channels.optJSONObject(id)?.optString("k") == hash) id.toLongOrNull()?.let(result::add)
        }
        return result
    }

    private fun channelConfig(channelId: Long): JSONObject? {
        val db = json ?: return null
        val channels = db.optJSONObject("channels") ?: JSONObject().also { db.put("channels", it) }
        return channels.optJSONObject(channelId.toString()) ?: JSONObject().apply {
            put("k", personalKeyHash)
            put("e", 0)
            put("d", "<#$channelId>")
            channels.put(channelId.toString(), this)
        }.also { it.put("l", System.currentTimeMillis()) }
    }

    private fun save() {
        val db = json ?: return
        file.parentFile?.mkdirs()
        file.writeText(db.toString(), Charsets.UTF_8)
    }

    private fun reset() {
        keyCache.clear()
        version++
    }
}
