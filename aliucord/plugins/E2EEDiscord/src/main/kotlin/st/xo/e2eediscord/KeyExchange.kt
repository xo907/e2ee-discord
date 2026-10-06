/*
 * E2EE-Discord for Aliucord — Made by XO.ST
 * https://github.com/xo907/e2ee-discord
 * SPDX-License-Identifier: LGPL-3.0-or-later
 *
 * Key exchange over DMs, compatible with the desktop plugin (see PROTOCOL.md):
 *   DH KEY → DH RESPONSE → PERSONAL KEY   sets up a shared DM key and swaps personal keys
 *   KEY REQUEST → KEY SHARE               shares a group/personal key over an existing DM key
 *
 * The phone shares its ECDH key pair with desktop (it came with the imported database), so it can
 * always learn keys passively from exchanges desktop handles. It only sends replies itself when
 * "answer key exchanges" is on, or for exchanges it started (/e2ee exchange).
 */

package st.xo.e2eediscord

import android.os.Handler
import android.os.Looper
import android.util.Base64
import com.aliucord.Logger
import com.aliucord.Utils
import com.aliucord.fragments.ConfirmDialog
import com.aliucord.utils.RxUtils.subscribe
import com.discord.restapi.RestAPIParams
import com.discord.stores.StoreChannels
import com.discord.stores.StoreStream
import com.discord.utilities.rest.RestAPI
import org.json.JSONArray
import org.json.JSONObject
import java.math.BigInteger
import java.security.AlgorithmParameters
import java.security.KeyFactory
import java.security.PrivateKey
import java.security.PublicKey
import java.security.spec.ECGenParameterSpec
import java.security.spec.ECParameterSpec
import java.security.spec.ECPoint
import java.security.spec.ECPrivateKeySpec
import java.security.spec.ECPublicKeySpec
import java.security.spec.PKCS8EncodedKeySpec
import java.util.Collections
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors
import java.util.regex.Pattern
import javax.crypto.KeyAgreement

/** ECDH on P-521, matching WebCrypto's raw public keys and deriveBits(256) */
internal object Ecdh {
    private val params: ECParameterSpec by lazy {
        AlgorithmParameters.getInstance("EC").run {
            init(ECGenParameterSpec("secp521r1"))
            getParameterSpec(ECParameterSpec::class.java)
        }
    }

    fun publicKey(raw: ByteArray): PublicKey {
        require(raw.size == 133 && raw[0] == 0x04.toByte()) { "invalid public key" }
        val x = BigInteger(1, raw.copyOfRange(1, 67))
        val y = BigInteger(1, raw.copyOfRange(67, 133))
        return KeyFactory.getInstance("EC").generatePublic(ECPublicKeySpec(ECPoint(x, y), params))
    }

    fun privateKey(bytes: ByteArray, isJwk: Boolean): PrivateKey {
        val factory = KeyFactory.getInstance("EC")
        if (!isJwk) return factory.generatePrivate(PKCS8EncodedKeySpec(bytes))
        val d = JSONObject(String(bytes, Charsets.UTF_8)).getString("d")
        val scalar = BigInteger(1, Base64.decode(d, Base64.URL_SAFE or Base64.NO_PADDING or Base64.NO_WRAP))
        return factory.generatePrivate(ECPrivateKeySpec(scalar, params))
    }

    /** First 256 bits of the shared x-coordinate (WebCrypto deriveBits(…, 256)) */
    fun sharedSecret(privateKey: PrivateKey, publicKey: PublicKey): ByteArray {
        val agreement = KeyAgreement.getInstance("ECDH")
        agreement.init(privateKey)
        agreement.doPhase(publicKey, true)
        val secret = agreement.generateSecret()
        val full = if (secret.size < 66) ByteArray(66 - secret.size) + secret else secret
        return full.copyOf(32)
    }
}

internal class KeyExchange(
    private val database: KeyDatabase,
    private val logger: Logger,
    /** Whether this phone answers key exchanges itself (otherwise desktop does, and the phone just learns) */
    private val answersExchanges: () -> Boolean,
    private val onKeysChanged: (String) -> Unit,
) {
    companion object {
        const val SYSTEM_HEADER = "```ml\n-----SYSTEM MESSAGE-----\n```"
        const val SYSTEM_TAG_LINE = "-# 🔑 E2EE-Discord key exchange · [what is this?](<https://github.com/xo907/e2ee-discord>)"
        private const val TYPE_GROUP = 1
        private const val TYPE_CONVERSATION = 2
        private const val TYPE_PERSONAL = 3
        private const val DM_CHANNEL = 1
        private const val RELATIONSHIP_FRIEND = 1
    }

    private val executor = Executors.newSingleThreadExecutor()
    private val mainHandler = Handler(Looper.getMainLooper())
    private val processed = Collections.synchronizedSet(HashSet<Long>())

    /** DMs where this phone sent DH KEY, so it finishes the exchange (sends PERSONAL KEY) */
    private val startedHere = Collections.synchronizedSet(HashSet<Long>())

    /** Keys to ask for once the DM key exchange with that channel completes */
    private val pendingRequests = ConcurrentHashMap<Long, MutableSet<String>>()

    /** Keys already asked for (or declined) this session, to avoid repeated prompts */
    private val requestedKeys = Collections.synchronizedSet(HashSet<String>())

    /** Users we started an exchange with: their replies don't need another confirmation */
    private val whitelist = Collections.synchronizedSet(HashSet<Long>())

    /* ─────────────────────────────── incoming ─────────────────────────────── */

    /** Called for every message the app receives or loads; ignores anything that isn't a new key-exchange message */
    fun onMessage(messageId: Long, channelId: Long, authorId: Long, timestamp: Long, content: String?) {
        if (content == null || !content.startsWith("```")) return
        val matcher = Protocol.systemMessagePattern.matcher(content)
        if (!matcher.matches()) return
        if (!processed.add(messageId)) return
        if (!database.isUnlocked) {
            processed.remove(messageId) // try again once unlocked
            return
        }
        if (authorId == myId() || !isDm(channelId)) return
        // only messages newer than the last one handled in this DM (desktop keeps the same marker)
        if (timestamp <= database.channelSystemTime(channelId)) return
        database.setChannelSystemTime(channelId, timestamp)

        val body = matcher.group(1).orEmpty()
        executor.execute {
            try {
                handle(channelId, authorId, body)
            } catch (e: Throwable) {
                logger.error("Key exchange message failed", e)
            }
        }
    }

    private fun property(name: String, body: String): String? {
        val m = Pattern.compile("\\*" + Pattern.quote(name) + "\\*:\\s*`(.*?)`", Pattern.CASE_INSENSITIVE).matcher(body)
        return if (m.find()) m.group(1) else null
    }

    private fun handle(channelId: Long, authorId: Long, body: String) {
        when (property("type", body)) {
            "DH KEY" -> onDhKey(channelId, authorId, body)
            "DH RESPONSE" -> onDhResponse(channelId, authorId, body)
            "PERSONAL KEY" -> onPersonalKey(channelId, authorId, body)
            "KEY REQUEST" -> onKeyRequest(channelId, authorId, body)
            "KEY SHARE" -> onKeyShare(authorId, body)
        }
    }

    private fun deriveDmKey(channelId: Long, authorId: Long, theirPublicPayload: String): Pair<String, ByteArray> {
        val secret = Ecdh.sharedSecret(myPrivateKey(), Ecdh.publicKey(Protocol.payloadDecode(theirPublicPayload)))
        val hash = database.saveKey(secret, TYPE_CONVERSATION, "DM key with <@$authorId>")
        database.setChannelKey(channelId, hash)
        return hash to secret
    }

    private fun onDhKey(channelId: Long, authorId: Long, body: String) {
        val theirPublic = property("dhKey", body) ?: return
        val reply = answersExchanges()
        consentIfNeeded(authorId, reply, "Accept a key exchange from ${userName(authorId)}?") {
            val (dmHash, secret) = deriveDmKey(channelId, authorId, theirPublic)
            onKeysChanged("🔑 Secure DM set up with ${userName(authorId)}")
            if (reply) {
                val personal = myPersonalKey() ?: return@consentIfNeeded
                send(
                    channelId,
                    "*type*: `DH RESPONSE`\n*dhKey*: `${Protocol.payloadEncode(myPublicKey())}`\n" +
                        "*personalKey*: `${Protocol.payloadEncode(Protocol.aesEncrypt(secret, personal))}`",
                )
            }
            logger.info("DH KEY handled, DM key $dmHash")
        }
    }

    private fun onDhResponse(channelId: Long, authorId: Long, body: String) {
        val theirPublic = property("dhKey", body) ?: return
        val theirPersonalPayload = property("personalKey", body) ?: return
        val startedByUs = startedHere.remove(channelId)
        val reply = startedByUs || answersExchanges()
        consentIfNeeded(authorId, reply && !startedByUs, "Accept a key exchange from ${userName(authorId)}?") {
            val (dmHash, secret) = deriveDmKey(channelId, authorId, theirPublic)
            val theirPersonal = Protocol.aesDecrypt(secret, Protocol.payloadDecode(theirPersonalPayload))
            if (theirPersonal.size != 32) return@consentIfNeeded
            database.saveKey(theirPersonal, TYPE_PERSONAL, "<@$authorId>'s personal key")
            onKeysChanged("🔑 Secure DM set up with ${userName(authorId)}")
            if (reply) {
                val personal = myPersonalKey() ?: return@consentIfNeeded
                send(
                    channelId,
                    "*type*: `PERSONAL KEY`\n*key*: `${Protocol.payloadEncode(Protocol.fromBase64(dmHash))}`\n" +
                        "*personalKey*: `${Protocol.payloadEncode(Protocol.aesEncrypt(secret, personal))}`",
                )
            }
            flushPendingRequests(channelId)
        }
    }

    private fun onPersonalKey(channelId: Long, authorId: Long, body: String) {
        val keyHash = property("key", body)?.let { Protocol.base64(Protocol.payloadDecode(it)) } ?: return
        val theirPersonalPayload = property("personalKey", body) ?: return
        val key = (database.getKey(keyHash) as? KeyLookup.Found)?.key ?: return
        val theirPersonal = Protocol.aesDecrypt(key, Protocol.payloadDecode(theirPersonalPayload))
        if (theirPersonal.size != 32) return
        database.saveKey(theirPersonal, TYPE_PERSONAL, "<@$authorId>'s personal key")
        onKeysChanged("🔑 Got ${userName(authorId)}'s personal key")
        flushPendingRequests(channelId)
    }

    private fun onKeyRequest(channelId: Long, authorId: Long, body: String) {
        if (!answersExchanges()) return // desktop answers
        val requested = property("requestedKey", body)?.let { Protocol.base64(Protocol.payloadDecode(it)) } ?: return
        shareKey(channelId, authorId, requested, askFirst = needsConsent(authorId))
    }

    private fun onKeyShare(authorId: Long, body: String) {
        if (property("status", body) != "OK") return
        val keyHash = property("key", body)?.let { Protocol.base64(Protocol.payloadDecode(it)) } ?: return
        val sharedPayload = property("sharedKey", body) ?: return
        val type = when (property("keyType", body)) {
            "GROUP" -> TYPE_GROUP
            "CONVERSATION" -> TYPE_CONVERSATION
            "PERSONAL" -> TYPE_PERSONAL
            else -> return
        }
        var descriptor = property("keyDescriptor", body) ?: return
        val key = (database.getKey(keyHash) as? KeyLookup.Found)?.key ?: return
        val shared = Protocol.aesDecrypt(key, Protocol.payloadDecode(sharedPayload))
        if (shared.size != 32) return
        if (type != TYPE_GROUP) descriptor += " by <@$authorId>"
        val sharedHash = database.saveKey(shared, type, descriptor, property("keyHidden", body) == "YES")

        if (type == TYPE_GROUP) {
            val channels = try {
                JSONArray(property("sharedChannels", body) ?: "[]")
            } catch (e: Throwable) {
                JSONArray()
            }
            for (i in 0 until minOf(channels.length(), 20)) {
                val id = channels.optString(i).toLongOrNull() ?: continue
                // only fill in channels with no settings yet, like desktop
                if (!database.hasChannelConfig(id)) database.setChannelKey(id, sharedHash)
            }
        }
        onKeysChanged("🔑 ${userName(authorId)} shared a key with you")
    }

    /* ─────────────────────────────── outgoing ─────────────────────────────── */

    /** /e2ee exchange: starts a DM key exchange from this phone */
    fun startExchange(channelId: Long, userId: Long?) {
        if (userId != null) whitelist.add(userId)
        startedHere.add(channelId)
        executor.execute {
            send(channelId, "*type*: `DH KEY`\n*dhKey*: `${Protocol.payloadEncode(myPublicKey())}`")
        }
    }

    /** A message used a key this phone doesn't have: ask its author for it (when this phone answers exchanges) */
    fun onMissingKey(keyHash: String, authorId: Long) {
        if (!answersExchanges() || !database.isUnlocked || authorId == myId()) return
        if (!requestedKeys.add("$keyHash/$authorId")) return
        val dm = findDm(authorId) ?: return
        val prompt = "Ask ${userName(authorId)} for the key to their encrypted message?"
        consentIfNeeded(authorId, true, prompt) {
            whitelist.add(authorId)
            val dmKey = database.channelKeyHash(dm)
            if (dmKey != null && database.keyType(dmKey) == TYPE_CONVERSATION) {
                sendKeyRequest(dm, keyHash)
            } else {
                // no secure DM yet: set one up first, then ask
                pendingRequests.getOrPut(dm) { Collections.synchronizedSet(HashSet()) }.add(keyHash)
                startedHere.add(dm)
                send(dm, "*type*: `DH KEY`\n*dhKey*: `${Protocol.payloadEncode(myPublicKey())}`")
            }
        }
    }

    private fun flushPendingRequests(channelId: Long) {
        val keys = pendingRequests.remove(channelId) ?: return
        for (hash in keys) if (database.getKey(hash) !is KeyLookup.Found) sendKeyRequest(channelId, hash)
    }

    private fun sendKeyRequest(channelId: Long, keyHash: String) {
        send(channelId, "*type*: `KEY REQUEST`\n*requestedKey*: `${Protocol.payloadEncode(Protocol.fromBase64(keyHash))}`")
    }

    private fun shareKey(channelId: Long, userId: Long, keyHash: String, askFirst: Boolean) {
        if (database.getKey(keyHash) !is KeyLookup.Found) {
            send(channelId, "*type*: `KEY SHARE`\n*status*: `NOT FOUND`")
            return
        }
        val channelKey = database.channelKeyHash(channelId)
        val mustAsk = (askFirst || database.isKeyHidden(keyHash)) && !database.isKeyTrusted(channelKey)
        val doShare = {
            val shared = (database.getKey(keyHash) as KeyLookup.Found).key
            val dmKey = channelKey?.let { (database.getKey(it) as? KeyLookup.Found)?.key }
            if (channelKey != null && dmKey != null) {
                val type = database.keyType(keyHash)
                val typeName = when (type) {
                    TYPE_GROUP -> "GROUP"
                    TYPE_CONVERSATION -> "CONVERSATION"
                    else -> "PERSONAL"
                }
                val descriptor = if (keyHash == database.personalKeyHash) "<@${myId()}>'s personal key"
                else database.keyName(keyHash).orEmpty()
                val message = StringBuilder()
                    .append("*type*: `KEY SHARE`\n*status*: `OK`\n")
                    .append("*key*: `${Protocol.payloadEncode(Protocol.fromBase64(channelKey))}`\n")
                    .append("*sharedKey*: `${Protocol.payloadEncode(Protocol.aesEncrypt(dmKey, shared))}`\n")
                    .append("*keyType*: `${if (keyHash == database.personalKeyHash) "PERSONAL" else typeName}`\n")
                    .append("*keyDescriptor*: `$descriptor`")
                if (type == TYPE_GROUP && keyHash != database.personalKeyHash) {
                    if (database.isKeyHidden(keyHash)) message.append("\n*keyHidden*: `YES`")
                    val channels = database.channelsUsingKey(keyHash).filter { !isDm(it) }.take(20)
                    message.append("\n*sharedChannels*: `${JSONArray(channels.map { it.toString() })}`")
                }
                send(channelId, message.toString())
            }
        }
        if (!mustAsk) {
            doShare()
            return
        }
        confirm(
            "Share the key \"${database.keyName(keyHash).orEmpty()}\" with ${userName(userId)}?",
            onYes = { doShare() },
            onNo = { send(channelId, "*type*: `KEY SHARE`\n*status*: `DENIED`") },
        )
    }

    /** Sends a key-exchange message as is (MessageSender never encrypts these) */
    private fun send(channelId: Long, body: String) {
        val content = "$SYSTEM_HEADER$body\n$SYSTEM_TAG_LINE"
        val nonce = ((System.currentTimeMillis() - 1420070400000L) shl 22).toString()
        val params = RestAPIParams.Message(content, nonce, null, null, null, null, null, null, null)
        mainHandler.post {
            try {
                RestAPI.api.sendMessage(channelId, params).subscribe { }
            } catch (e: Throwable) {
                logger.error("Couldn't send a key exchange message", e)
            }
        }
    }

    /* ─────────────────────────────── helpers ─────────────────────────────── */

    private fun needsConsent(userId: Long): Boolean {
        if (whitelist.contains(userId)) return false
        return !(database.autoKeyExchangeWithFriends() && isFriend(userId))
    }

    /** Runs [action] on the worker thread, after asking the user when sending is involved and consent is needed */
    private fun consentIfNeeded(userId: Long, sends: Boolean, question: String, action: () -> Unit) {
        if (!sends || !needsConsent(userId)) {
            executor.execute { runSafely(action) }
            return
        }
        confirm(question, onYes = {
            whitelist.add(userId)
            runSafely(action)
        }, onNo = {})
    }

    private fun runSafely(action: () -> Unit) = try {
        action()
    } catch (e: Throwable) {
        logger.error("Key exchange failed", e)
    }

    private fun confirm(question: String, onYes: () -> Unit, onNo: () -> Unit) {
        mainHandler.post {
            try {
                val dialog = ConfirmDialog()
                dialog.setTitle("E2EE-Discord")
                    .setDescription(question)
                    .setOnOkListener {
                        dialog.dismiss()
                        executor.execute { runSafely(onYes) }
                    }
                    .setOnCancelListener {
                        dialog.dismiss()
                        executor.execute { runSafely(onNo) }
                    }
                dialog.show(Utils.appActivity.supportFragmentManager, "e2ee-confirm")
            } catch (e: Throwable) {
                logger.error("Couldn't ask for confirmation", e)
            }
        }
    }

    private fun myId(): Long = try {
        StoreStream.getUsers().me.id
    } catch (e: Throwable) {
        0L
    }

    private fun myPrivateKey(): PrivateKey {
        val bytes = database.dhPrivateKey() ?: throw IllegalStateException("no DH private key (database locked?)")
        return Ecdh.privateKey(bytes, database.dhPrivateKeyIsJwk)
    }

    private fun myPublicKey(): ByteArray = database.dhPublicKey() ?: throw IllegalStateException("no DH public key")

    private fun myPersonalKey(): ByteArray? =
        database.personalKeyHash?.let { (database.getKey(it) as? KeyLookup.Found)?.key }

    private fun isFriend(userId: Long): Boolean = try {
        StoreStream.getUserRelationships().relationships[userId] == RELATIONSHIP_FRIEND
    } catch (e: Throwable) {
        false
    }

    private fun userName(userId: Long): String = try {
        StoreStream.getUsers().users[userId]?.username ?: "user $userId"
    } catch (e: Throwable) {
        "user $userId"
    }

    private val channelTypeField by lazy {
        com.discord.api.channel.Channel::class.java.getDeclaredField("type").apply { isAccessible = true }
    }
    private val channelRecipientIdsField by lazy {
        com.discord.api.channel.Channel::class.java.getDeclaredField("recipientIds").apply { isAccessible = true }
    }
    private val channelRecipientsField by lazy {
        com.discord.api.channel.Channel::class.java.getDeclaredField("recipients").apply { isAccessible = true }
    }
    private val userIdField by lazy {
        com.discord.api.user.User::class.java.getDeclaredField("id").apply { isAccessible = true }
    }

    fun isDm(channelId: Long): Boolean = try {
        val channel = StoreStream.getChannels().getChannel(channelId)
        channel != null && channelTypeField.getInt(channel) == DM_CHANNEL
    } catch (e: Throwable) {
        false
    }

    /** The other person in a DM */
    fun dmRecipient(channelId: Long): Long? = try {
        StoreStream.getChannels().getChannel(channelId)?.let(::recipientsOf)?.firstOrNull { it != myId() }
    } catch (e: Throwable) {
        null
    }

    private fun recipientsOf(channel: com.discord.api.channel.Channel): List<Long> {
        @Suppress("UNCHECKED_CAST")
        (channelRecipientIdsField.get(channel) as List<Long>?)?.let { if (it.isNotEmpty()) return it }
        @Suppress("UNCHECKED_CAST")
        val users = channelRecipientsField.get(channel) as List<Any>? ?: return emptyList()
        return users.map { userIdField.getLong(it) }
    }

    /** The DM channel with a user, if one exists */
    private fun findDm(userId: Long): Long? = try {
        StoreStream.getChannels().getChannelsForGuild(StoreChannels.PRIVATE_CHANNELS_ID).values.firstOrNull {
            channelTypeField.getInt(it) == DM_CHANNEL && userId in recipientsOf(it)
        }?.let { channel -> com.discord.api.channel.Channel::class.java.getDeclaredField("id").run { isAccessible = true; getLong(channel) } }
    } catch (e: Throwable) {
        null
    }
}
