/*
 * E2EE-Discord for Aliucord — Made by XO.ST
 * https://github.com/xo907/e2ee-discord
 * SPDX-License-Identifier: LGPL-3.0-or-later
 *
 * Phase 1: reads messages encrypted by E2EE-Discord / SimpleDiscordCrypt on desktop.
 * Phase 2: sends and edits encrypted messages (/e2ee on).
 * Phase 3: key exchange.
 * Phase 4: encrypted files, images, video and audio.
 * 0.5.0: sealed messages, 3.0 databases, and an indicator on the message box while encryption is on.
 */

package st.xo.e2eediscord

import android.content.Context
import android.content.res.ColorStateList
import android.graphics.Color
import android.graphics.drawable.GradientDrawable
import android.os.Handler
import android.os.Looper
import android.view.View
import android.view.ViewGroup
import android.widget.EditText
import androidx.recyclerview.widget.RecyclerView
import com.aliucord.Utils
import com.aliucord.annotations.AliucordPlugin
import com.aliucord.api.CommandsAPI
import com.aliucord.entities.CommandContext
import com.aliucord.entities.Plugin
import com.aliucord.patcher.Hook
import com.aliucord.patcher.PreHook
import com.aliucord.patcher.after
import com.aliucord.patcher.before
import com.discord.api.commands.ApplicationCommandType
import com.discord.api.message.attachment.MessageAttachment
import com.discord.models.message.Message
import com.discord.utilities.messagesend.MessageRequest
import com.discord.widgets.chat.list.adapter.WidgetChatListAdapterItemAttachment
import com.discord.widgets.chat.list.entries.AttachmentEntry
import com.discord.widgets.chat.list.entries.ChatListEntry
import java.io.File
import java.lang.ref.WeakReference
import com.discord.restapi.PayloadJSON
import com.discord.restapi.RestAPIParams
import com.discord.stores.StoreChat
import com.discord.stores.StoreMessageReplies
import com.discord.stores.StoreMessages
import com.discord.stores.StoreMessagesLoader
import com.discord.utilities.rest.RestAPI
import com.discord.utilities.rest.SendUtils
import com.discord.utilities.view.text.SimpleDraweeSpanTextView
import com.discord.widgets.chat.list.adapter.WidgetChatListAdapterItemMessage
import com.discord.widgets.chat.list.entries.MessageEntry
import de.robv.android.xposed.XC_MethodHook
import okhttp3.MultipartBody
import java.util.regex.Pattern

@AliucordPlugin(requiresRestart = false)
@Suppress("unused")
class E2EEDiscord : Plugin() {
    internal lateinit var database: KeyDatabase
        private set
    private lateinit var decryptor: MessageDecryptor
    private lateinit var sender: MessageSender
    private val mainHandler = Handler(Looper.getMainLooper())

    // While Discord renders a message, its chat row points at a copy holding the decrypted text
    // (see swapIn). The stored message is never changed, so nothing can send plaintext back.
    private val contentField by lazy {
        Message::class.java.getDeclaredField("content").apply { isAccessible = true }
    }
    private val paramsContentField by lazy {
        RestAPIParams.Message::class.java.getDeclaredField("content").apply { isAccessible = true }
    }
    private val payloadDataField by lazy {
        PayloadJSON::class.java.getDeclaredField("data").apply { isAccessible = true }
    }
    private val paramsNonceField by lazy {
        RestAPIParams.Message::class.java.getDeclaredField("nonce").apply { isAccessible = true }
    }
    private val sendAttachmentsField by lazy {
        MessageRequest.Send::class.java.getDeclaredField("attachments").apply { isAccessible = true }
    }
    private val editingContentField by lazy {
        StoreChat.EditingMessage::class.java.getDeclaredField("content").apply { isAccessible = true }
    }
    private val swapped = ArrayList<Pair<MessageEntry, Message>>()

    init {
        settingsTab = SettingsTab(E2EESettings::class.java).withArgs(this)
    }

    override fun start(context: Context) {
        database = KeyDatabase(context.applicationContext.filesDir)
        try {
            database.load()
        } catch (e: Throwable) {
            logger.error("Couldn't load the key database", e)
        }
        decryptor = MessageDecryptor(database, logger)
        sender = MessageSender(database)
        keyExchange = KeyExchange(
            database,
            logger,
            answersExchanges = { settings.getBool(SETTING_ANSWER_EXCHANGES, false) },
            onKeysChanged = { text -> mainHandler.post { Utils.showToast(text) } },
        )

        val cache = File(context.cacheDir, "e2ee-discord")
        attachmentDecryptor = AttachmentDecryptor(decryptor, File(cache, "files"), logger) { message ->
            database.channelKeyHash(message.channelId)?.let { (database.getKey(it) as? KeyLookup.Found)?.key }
        }
        attachmentEncryptor = AttachmentEncryptor(File(cache, "uploads"))
        attachmentDecryptor.onError = { text -> Utils.showToast(text, true) }

        // each part starts on its own, so one failing hook doesn't take the others down
        hookStatus.clear()
        startPart("reading", ::patchReading)
        startPart("sending", ::patchSending)
        startPart("file uploads", ::patchUploads)
        startPart("key exchange", ::patchKeyExchange)
        startPart("attachments", ::patchAttachments)
        startPart("attachment taps", ::patchAttachmentTaps)
        startPart("/e2ee command", ::registerCommands)
        startPart("indicator", ::patchIndicator)
    }

    // how often the send hooks ran, for /e2ee debug
    @Volatile private var earlyHookHits = 0
    @Volatile private var lateHookHits = 0

    /** What happened to recent sends, for /e2ee debug (lengths only, never the text) */
    private val sendTrace = java.util.Collections.synchronizedMap(object : LinkedHashMap<String, String>() {
        override fun removeEldestEntry(eldest: MutableMap.MutableEntry<String, String>?) = size > 5
    })

    private fun trace(nonce: String, step: String) {
        synchronized(sendTrace) { sendTrace[nonce] = (sendTrace[nonce]?.let { "$it; " } ?: "") + step }
    }

    private fun describe(text: String): String = when {
        text.isEmpty() -> "empty"
        text[0] in '⠀'..'⣿' && Protocol.messagePattern.matcher(text).matches() ->
            "encrypted(${Protocol.messagePattern.matcher(text).run { matches(); group(1)!!.length }})"
        else -> "plain(${text.length}${if (text.startsWith("🔒")) ", starts with 🔒" else ""})"
    }

    /** Which parts started, for /e2ee debug */
    private val hookStatus = LinkedHashMap<String, String>()

    private fun startPart(name: String, start: () -> Unit) {
        hookStatus[name] = try {
            start()
            "ok"
        } catch (e: Throwable) {
            logger.error("Couldn't start $name", e)
            "FAILED — $e"
        }
    }

    private fun debugReport(channelId: Long): String {
        val inlineMedia = try {
            com.discord.stores.StoreStream.getUserSettings().isAttachmentMediaInline
        } catch (e: Throwable) {
            null
        }
        return buildString {
            append("🛠 **E2EE-Discord $VERSION** debug\n")
            append("Database: ").append(
                when {
                    !database.isLoaded -> "not imported"
                    !database.isUnlocked -> "locked"
                    else -> "unlocked, ${database.keyCount} keys"
                },
            ).append(" · this chat: ").append(if (database.isChannelEncrypted(channelId)) "encrypted" else "not encrypted").append('\n')
            append("Parts: ").append(hookStatus.entries.joinToString(" · ") { "${it.key} ${it.value}" }).append('\n')
            val selfTest = try {
                val hash = database.channelKeyHash(channelId)
                val key = hash?.let { (database.getKey(it) as? KeyLookup.Found)?.key }
                if (key == null) "no usable key for this chat"
                else {
                    val back = Protocol.decryptFileNameOrThrow(key, Protocol.encryptFileName(key, "selftest.png"))
                    (if (back == "selftest.png") "ok" else "MISMATCH ($back)") + " · key ${hash.take(6)}, ${key.size} bytes"
                }
            } catch (e: Throwable) {
                "FAILED — $e"
            }
            append("Send hooks run since start: queue $earlyHookHits · request $lateHookHits\n")
            append("Name encryption self-test: ").append(selfTest).append('\n')
            append("Recent sends:\n").append(
                synchronized(sendTrace) { sendTrace.values.toList() }.reversed().joinToString("\n") { "• $it" }.ifEmpty { "none yet" },
            ).append('\n')
            if (inlineMedia == false) append("⚠️ Discord's \"Show attachments inline\" setting is off, so images only show as file cards.\n")
            append("Recent attachments:\n").append(attachmentDecryptor.debugReport())
        }
    }

    private lateinit var attachmentDecryptor: AttachmentDecryptor
    private lateinit var attachmentEncryptor: AttachmentEncryptor

    /** Deletes decrypted copies of attachments; they're decrypted again when shown */
    internal fun clearDecryptedFiles() {
        attachmentDecryptor.clearCache()
    }

    internal lateinit var keyExchange: KeyExchange
        private set

    companion object {
        internal const val SETTING_ANSWER_EXCHANGES = "answerKeyExchanges"
        internal const val VERSION = "0.5.0"

        // the red of the desktop plugin's lock and outline
        private const val INDICATOR_COLOR = 0xFFFF0000.toInt()
        private const val INDICATOR_HINT_COLOR = 0xFFFF5C5C.toInt()
    }

    /* ─────────────────────────────── indicator ─────────────────────────────── */

    // Like the red outline on desktop: while encryption is on in the open chat, the message box
    // gets a red outline and its placeholder says so. Nothing in Discord's layout is changed: the
    // outline is drawn in an overlay, and the placeholder is put back when encryption is off.

    private class Indicator(
        val host: View,
        val outline: GradientDrawable,
        val layoutListener: View.OnLayoutChangeListener,
        var originalHint: CharSequence?,
        val originalHintColors: ColorStateList?,
        var label: String,
    )

    private val indicators = java.util.WeakHashMap<EditText, Indicator>()
    private var messageBox: WeakReference<EditText>? = null

    private fun patchIndicator() {
        // looked up by name, so a Discord build without it only disables the indicator
        val widget = Class.forName("com.discord.widgets.chat.input.WidgetChatInput")
        val getView = widget.getMethod("getView")
        val configure = widget.declaredMethods.filter { it.name == "configureUI" }
        if (configure.isEmpty()) throw NoSuchMethodException("WidgetChatInput.configureUI")
        for (method in configure) {
            // runs whenever the message box is set up again, including when another chat is opened
            patcher.patch(
                method,
                Hook { param ->
                    try {
                        val root = getView.invoke(param.thisObject) as View? ?: return@Hook
                        val input = findMessageBox(root) ?: return@Hook
                        messageBox = WeakReference(input)
                        updateIndicator(input)
                    } catch (e: Throwable) {
                        logger.error("Couldn't update the encryption indicator", e)
                    }
                },
            )
        }
    }

    private fun findMessageBox(root: View): EditText? {
        val id = Utils.getResId("text_input", "id")
        if (id != 0) (root.findViewById<View>(id) as? EditText)?.let { return it }
        return firstEditText(root)
    }

    private fun firstEditText(view: View): EditText? {
        if (view is EditText) return view
        if (view is ViewGroup) {
            for (i in 0 until view.childCount) firstEditText(view.getChildAt(i))?.let { return it }
        }
        return null
    }

    /** Shows the current state on the message box again; call on the main thread */
    private fun refreshIndicator() {
        try {
            messageBox?.get()?.let { updateIndicator(it) }
        } catch (e: Throwable) {
            logger.error("Couldn't update the encryption indicator", e)
        }
    }

    private fun updateIndicator(input: EditText) {
        val channelId = com.discord.stores.StoreStream.getChannelsSelected().id
        val shown = indicators[input]
        if (!database.isLoaded || !database.isChannelEncrypted(channelId)) {
            if (shown != null) removeIndicator(input, shown)
            return
        }
        val label = if (database.isUnlocked) {
            "🔒 Encrypted · ${keyLabel(database.channelKeyHash(channelId))}"
        } else {
            "🔒 Encryption is on, but the database is locked"
        }

        if (shown == null) {
            val density = input.resources.displayMetrics.density
            val outline = GradientDrawable().apply {
                shape = GradientDrawable.RECTANGLE
                setColor(Color.TRANSPARENT)
                setStroke((1.5f * density).toInt().coerceAtLeast(2), INDICATOR_COLOR)
                cornerRadius = 8f * density
            }
            // around the box the text field sits in: the field itself scrolls, which would move the outline
            val host = input.parent as? View ?: input
            val layoutListener = View.OnLayoutChangeListener { view, _, _, _, _, _, _, _, _ ->
                outline.setBounds(0, 0, view.width, view.height)
            }
            outline.setBounds(0, 0, host.width, host.height)
            host.overlay.add(outline)
            host.addOnLayoutChangeListener(layoutListener)
            indicators[input] = Indicator(host, outline, layoutListener, input.hint, input.hintTextColors, label)
        } else {
            // Discord sets its own placeholder again when the chat changes: that's the one to restore
            if (input.hint?.toString() != shown.label) shown.originalHint = input.hint
            shown.label = label
        }
        input.hint = label
        input.setHintTextColor(INDICATOR_HINT_COLOR)
    }

    private fun removeIndicator(input: EditText, shown: Indicator) {
        indicators.remove(input)
        shown.host.overlay.remove(shown.outline)
        shown.host.removeOnLayoutChangeListener(shown.layoutListener)
        if (input.hint?.toString() == shown.label) input.hint = shown.originalHint
        shown.originalHintColors?.let { input.setHintTextColor(it) }
    }

    private fun removeAllIndicators() {
        for ((input, shown) in indicators.entries.toList()) {
            try {
                removeIndicator(input, shown)
            } catch (e: Throwable) {
                logger.error("Couldn't remove the encryption indicator", e)
            }
        }
        messageBox = null
    }

    /* ─────────────────────────────── key exchange ─────────────────────────────── */

    private fun field(clazz: Class<*>, name: String) = clazz.getDeclaredField(name).apply { isAccessible = true }
    private val apiMessageClass = com.discord.api.message.Message::class.java
    private val fApiId by lazy { field(apiMessageClass, "id") }
    private val fApiChannelId by lazy { field(apiMessageClass, "channelId") }
    private val fApiAuthor by lazy { field(apiMessageClass, "author") }
    private val fApiContent by lazy { field(apiMessageClass, "content") }
    private val fApiTimestamp by lazy { field(apiMessageClass, "timestamp") }
    private val fUserId by lazy { field(com.discord.api.user.User::class.java, "id") }
    private val fDateTimeMillis by lazy { field(com.discord.api.utcdatetime.UtcDateTime::class.java, "dateTimeMillis") }
    private val fChunkMessages by lazy { field(StoreMessagesLoader.ChannelChunk::class.java, "messages") }

    private fun millis(time: Any?): Long = if (time == null) 0L else fDateTimeMillis.getLong(time)

    private fun patchKeyExchange() {
        // messages arriving live
        patcher.after<StoreMessages>("handleMessageCreate", List::class.java) { param ->
            try {
                for (message in param.args[0] as List<*>? ?: return@after) {
                    if (message == null) continue
                    val author = fApiAuthor.get(message) ?: continue
                    keyExchange.onMessage(
                        fApiId.getLong(message),
                        fApiChannelId.getLong(message),
                        fUserId.getLong(author),
                        millis(fApiTimestamp.get(message)),
                        fApiContent.get(message) as String?,
                    )
                }
            } catch (e: Throwable) {
                logger.error("Couldn't check new messages for key exchanges", e)
            }
        }
        // history (exchanges that happened while the app was closed), oldest first
        patcher.after<StoreMessages>("handleMessagesLoaded", StoreMessagesLoader.ChannelChunk::class.java) { param ->
            try {
                @Suppress("UNCHECKED_CAST")
                val messages = fChunkMessages.get(param.args[0]) as List<Message>? ?: return@after
                for (message in messages.sortedBy { millis(it.timestamp) }) {
                    val author = message.author ?: continue
                    keyExchange.onMessage(message.id, message.channelId, fUserId.getLong(author), millis(message.timestamp), message.content)
                }
            } catch (e: Throwable) {
                logger.error("Couldn't check loaded messages for key exchanges", e)
            }
        }
    }

    override fun stop(context: Context) {
        patcher.unpatchAll()
        commands.unregisterCommand("e2ee")
        restoreSwapped()
        mainHandler.post { removeAllIndicators() }
    }

    /** Called by the settings page when the database was imported, unlocked or removed */
    internal fun onDatabaseChanged() {
        // the decryptor notices the new database version and drops its cache
        logger.info("Key database changed: ${database.keyCount} keys, unlocked=${database.isUnlocked}")
        mainHandler.post { refreshIndicator() }
    }

    /* ─────────────────────────────── reading ─────────────────────────────── */

    private fun patchReading() {
        // message text
        patcher.before<WidgetChatListAdapterItemMessage>(
            "processMessageText",
            SimpleDraweeSpanTextView::class.java,
            MessageEntry::class.java,
        ) { param ->
            restoreSwapped()
            swapIn(param.args[1] as MessageEntry)
        }
        patcher.after<WidgetChatListAdapterItemMessage>(
            "processMessageText",
            SimpleDraweeSpanTextView::class.java,
            MessageEntry::class.java,
        ) { restoreSwapped() }

        // the quoted message above replies
        patcher.before<WidgetChatListAdapterItemMessage>("configureReplyPreview", MessageEntry::class.java) { param ->
            restoreSwapped()
            val replyData = (param.args[0] as MessageEntry).replyData ?: return@before
            if (replyData.messageState !is StoreMessageReplies.MessageState.Loaded) return@before
            swapIn(replyData.messageEntry)
        }
        patcher.after<WidgetChatListAdapterItemMessage>("configureReplyPreview", MessageEntry::class.java) {
            restoreSwapped()
        }
    }

    /* ─────────────────────────────── attachments ─────────────────────────────── */

    private val getAdapterMethod by lazy {
        WidgetChatListAdapterItemAttachment::class.java
            .getDeclaredMethod("access\$getAdapter\$p", WidgetChatListAdapterItemAttachment::class.java)
            .apply { isAccessible = true }
    }

    private fun patchAttachments() {
        // decrypt attachments as they're shown; images and videos then render inline
        patcher.before<WidgetChatListAdapterItemAttachment>("onConfigure", Int::class.java, ChatListEntry::class.java) { param ->
            val entry = param.args[1] as? AttachmentEntry ?: return@before
            try {
                val adapter = getAdapterMethod.invoke(null, param.thisObject) as RecyclerView.Adapter<*>?
                attachmentDecryptor.prepare(entry.message, entry.attachment) { adapter?.notifyDataSetChanged() }
            } catch (e: Throwable) {
                logger.error("Couldn't prepare an encrypted attachment", e)
            }
        }
    }

    private fun patchAttachmentTaps() {
        // the download button of a file card: save the decrypted file instead of the ciphertext
        val downloadClick = Class.forName("com.discord.widgets.chat.list.adapter.WidgetChatListAdapterItemAttachment\$configureFileData\$2")
        val downloadData = downloadClick.getDeclaredField("\$data").apply { isAccessible = true }
        patcher.patch(
            downloadClick.getDeclaredMethod("onClick", View::class.java),
            PreHook { param ->
                val attachment = downloadData.get(param.thisObject) as MessageAttachment? ?: return@PreHook
                if (!attachmentDecryptor.isOurs(attachment)) return@PreHook
                param.result = null
                saveAttachment((param.args[0] as View).context, attachment, open = false)
            },
        )

        // tapping an attachment: decrypted images and videos open in Discord's viewer as usual;
        // other files are decrypted, saved to Downloads and opened
        patcher.patch(
            "com.discord.widgets.chat.list.adapter.WidgetChatListAdapterItemAttachment\$Companion",
            "navigateToAttachment",
            arrayOf(Context::class.java, MessageAttachment::class.java),
            PreHook { param ->
                val attachment = param.args[1] as MessageAttachment? ?: return@PreHook
                if (!attachmentDecryptor.isOurs(attachment) || attachmentDecryptor.isViewableMedia(attachment)) return@PreHook
                param.result = null
                saveAttachment(param.args[0] as Context, attachment, open = true)
            },
        )
    }

    private fun saveAttachment(context: Context, attachment: MessageAttachment, open: Boolean) {
        Utils.showToast("Decrypting ${attachmentDecryptor.displayName(attachment)}…")
        attachmentDecryptor.fetchFile(attachment) { file, name ->
            if (file == null) {
                Utils.showToast("Couldn't download or decrypt $name", true)
                return@fetchFile
            }
            Thread {
                try {
                    val uri = FileSaver.saveToDownloads(context, file, name)
                    mainHandler.post {
                        if (!open || uri == null || !FileSaver.open(context, uri, name)) {
                            Utils.showToast("Saved ${name.removePrefix("SPOILER_")} to Downloads")
                        }
                    }
                } catch (e: Throwable) {
                    logger.error("Couldn't save $name", e)
                    mainHandler.post { Utils.showToast("Couldn't save $name: ${e.message}", true) }
                }
            }.start()
        }
    }

    private val entryMessageField by lazy {
        MessageEntry::class.java.getDeclaredField("message").apply { isAccessible = true }
    }

    // a private copy of a message, made without running any of Discord's code
    private val unsafe by lazy {
        Class.forName("sun.misc.Unsafe").getDeclaredField("theUnsafe").apply { isAccessible = true }.get(null)
    }
    private val allocateInstance by lazy {
        Class.forName("sun.misc.Unsafe").getMethod("allocateInstance", Class::class.java)
    }
    private val messageFields by lazy {
        Message::class.java.declaredFields
            .filter { !java.lang.reflect.Modifier.isStatic(it.modifiers) }
            .onEach { it.isAccessible = true }
    }

    private fun copyWithContent(message: Message, content: String): Message {
        val copy = allocateInstance.invoke(unsafe, Message::class.java) as Message
        for (field in messageFields) field.set(copy, field.get(message))
        contentField.set(copy, content)
        return copy
    }

    /**
     * Shows [entry]'s message decrypted by pointing the chat row at a private copy holding the
     * decrypted text. Discord's stored message is never touched, so nothing else — sending, editing,
     * copying — can ever pick up the decrypted text.
     */
    private fun swapIn(entry: MessageEntry?) {
        val message = entry?.message ?: return
        try {
            val original = message.content
            val display = decryptor.display(original) ?: return
            entryMessageField.set(entry, copyWithContent(message, display))
            swapped.add(entry to message)
            if (display == MessageDecryptor.MISSING_KEY_HINT) {
                val keyHash = decryptor.keyHashOf(original)
                val author = message.author
                if (keyHash != null && author != null) keyExchange.onMissingKey(keyHash, fUserId.getLong(author))
            }
        } catch (e: Throwable) {
            logger.error("Couldn't decrypt a message", e)
        }
    }

    private fun restoreSwapped() {
        if (swapped.isEmpty()) return
        for ((entry, message) in swapped) {
            try {
                entryMessageField.set(entry, message)
            } catch (e: Throwable) {
                logger.error("Couldn't restore a message", e)
            }
        }
        swapped.clear()
    }

    /* ─────────────────────────────── sending ─────────────────────────────── */

    private fun patchSending() {
        // text messages
        patcher.before<RestAPI>("sendMessage", Long::class.java, RestAPIParams.Message::class.java) { param ->
            handleOutgoing(param, param.args[0] as Long, param.args[1] as RestAPIParams.Message?, null)
        }
        // messages with files
        patcher.before<RestAPI>(
            "sendMessage",
            Long::class.java,
            PayloadJSON::class.java,
            Array<MultipartBody.Part>::class.java,
        ) { param ->
            val message = payloadDataField.get(param.args[1]) as? RestAPIParams.Message
            val parts = param.args[2] as Array<*>?
            val files = when {
                parts == null || parts.isEmpty() -> MessageSender.Files.None
                else -> (message?.let { paramsNonceField.get(it) as String? })
                    ?.let { sender.encryptedUploads[it] }
                    ?.let { MessageSender.Files.Encrypted(it) }
                    ?: MessageSender.Files.Plain
            }
            handleOutgoing(param, param.args[0] as Long, message, null, files)
        }
        // edits
        patcher.before<RestAPI>("editMessage", Long::class.java, Long::class.java, RestAPIParams.Message::class.java) { param ->
            handleOutgoing(param, param.args[0] as Long, param.args[2] as RestAPIParams.Message?, param.args[1] as Long)
        }
        patchEditing()
    }

    private fun patchUploads() {
        // files: swap in encrypted copies before Discord builds the upload. The send hook above then
        // encrypts the text with the same key, or refuses to send if the files couldn't be encrypted.
        patcher.patch(
            "com.discord.utilities.messagesend.MessageQueue",
            "doSend",
            arrayOf(MessageRequest.Send::class.java, Class.forName("com.discord.utilities.messagesend.MessageQueue\$DrainListener")),
            PreHook { param ->
                val send = param.args[0] as MessageRequest.Send? ?: return@PreHook
                val message = send.message ?: return@PreHook
                val nonce = message.nonce ?: return@PreHook
                sender.queuedChannels[nonce] = message.channelId
                val attachments = send.attachments
                if (attachments.isNullOrEmpty()) return@PreHook
                try {
                    if (attachmentEncryptor.isEncrypted(attachments)) return@PreHook // a retry
                    val decision = sender.decide(message.channelId, message.content)
                    if (decision !is MessageSender.Decision.Encrypt) return@PreHook
                    val encrypted = attachmentEncryptor.encrypt(Utils.appContext.contentResolver, attachments, decision.key)
                    sendAttachmentsField.set(send, encrypted)
                    sender.encryptedUploads[nonce] = decision.keyHash
                } catch (e: Throwable) {
                    logger.error("Couldn't encrypt attachments", e)
                }
            },
        )

        // the message text, for every queued send. Discord builds the request from this, so it's
        // the dependable place: the RestAPI.sendMessage hooks can be skipped when Android inlines
        // that small method into its caller.
        patcher.patch(
            SendUtils::class.java.getDeclaredMethod(
                "getSendPayload",
                android.content.ContentResolver::class.java,
                RestAPIParams.Message::class.java,
                List::class.java,
            ),
            PreHook { param ->
                earlyHookHits++
                val message = param.args[1] as RestAPIParams.Message? ?: return@PreHook
                val nonce = paramsNonceField.get(message) as String? ?: return@PreHook
                val channelId = sender.queuedChannels[nonce] ?: return@PreHook
                val attachments = param.args[2] as List<*>?
                val files = when {
                    attachments.isNullOrEmpty() -> MessageSender.Files.None
                    else -> sender.encryptedUploads[nonce]?.let { MessageSender.Files.Encrypted(it) } ?: MessageSender.Files.Plain
                }
                val before = message.content.orEmpty()
                val blocked = applyOutcome(param, channelId, message, null, files)
                if (!blocked) sender.prepared[nonce] = message.content.orEmpty()
                trace(nonce, "queue: ${describe(before)} → ${if (blocked) "blocked" else describe(message.content.orEmpty())}" +
                    if (files !is MessageSender.Files.None) " · files ${files.javaClass.simpleName}" else "")
            },
        )
    }

    private fun patchEditing() {
        // editing an encrypted message: show its plaintext in the edit box, and remember its key
        patcher.before<StoreChat>("setEditingMessage", StoreChat.EditingMessage::class.java) { param ->
            val editing = param.args[0] as StoreChat.EditingMessage? ?: return@before
            try {
                val message = editing.message ?: return@before
                val original = message.content ?: return@before
                // only when editing starts, not on every keystroke of the draft
                if (editing.content?.toString() != original) return@before
                val plaintext = decryptor.plaintextFor(original) ?: return@before
                sender.editKeys[message.id] = plaintext.keyHash
                editingContentField.set(editing, plaintext.text)
            } catch (e: Throwable) {
                logger.error("Couldn't prepare an encrypted edit", e)
            }
        }
    }

    private fun handleOutgoing(
        param: XC_MethodHook.MethodHookParam,
        channelId: Long,
        message: RestAPIParams.Message?,
        editingMessageId: Long?,
        files: MessageSender.Files = MessageSender.Files.None,
    ) {
        lateHookHits++
        if (message == null) return
        // already prepared when it was queued: encrypt each message exactly once
        val nonce = paramsNonceField.get(message) as String?
        if (editingMessageId == null && nonce != null && sender.prepared.containsKey(nonce)) {
            trace(nonce, "request: skipped, ${describe(message.content.orEmpty())}")
            return
        }
        val before = message.content.orEmpty()
        applyOutcome(param, channelId, message, editingMessageId, files)
        if (nonce != null) trace(nonce, "request: ${describe(before)} → ${describe(message.content.orEmpty())}")
    }

    /** Encrypts [message] in place, or makes the hooked call fail; true if it was blocked */
    private fun applyOutcome(
        param: XC_MethodHook.MethodHookParam,
        channelId: Long,
        message: RestAPIParams.Message,
        editingMessageId: Long?,
        files: MessageSender.Files,
    ): Boolean {
        val outcome = try {
            sender.prepare(channelId, message.content, editingMessageId, files)
        } catch (e: Throwable) {
            logger.error("Encryption failed", e)
            // the user may have wanted this encrypted: never fall back to sending plaintext
            MessageSender.Outcome.Blocked("Encryption failed, so the message was not sent: ${e.message}")
        }
        return when (outcome) {
            MessageSender.Outcome.Plain -> false
            is MessageSender.Outcome.Replace -> {
                paramsContentField.set(message, outcome.content)
                false
            }
            is MessageSender.Outcome.Blocked -> {
                param.result = rx.Observable.x<Any>(IllegalStateException("E2EE-Discord: ${outcome.reason}"))
                mainHandler.post { Utils.showToast(outcome.reason, true) }
                true
            }
        }
    }

    /* ─────────────────────────────── /e2ee ─────────────────────────────── */

    private fun registerCommands() {
        val actions = listOf("on", "off", "status", "keys", "exchange", "debug").map { Utils.createCommandChoice(it, it) }
        commands.registerCommand(
            "e2ee",
            "E2EE-Discord: turn encryption on/off for this channel, or pick its key",
            listOf(
                Utils.createCommandOption(
                    ApplicationCommandType.STRING,
                    "action",
                    "on, off, status, keys, exchange (start a key exchange in a DM), or debug",
                    required = true,
                    choices = actions,
                ),
                Utils.createCommandOption(
                    ApplicationCommandType.STRING,
                    "key",
                    "With \"keys\": the number of the key to use in this channel",
                ),
            ),
        ) { ctx ->
            val reply = runCommand(ctx)
            mainHandler.post { refreshIndicator() } // on/off or the key may have changed
            CommandsAPI.CommandResult(reply, null, false)
        }
    }

    private fun runCommand(ctx: CommandContext): String {
        val channelId = ctx.channelId
        if (ctx.getRequiredString("action") == "debug") return debugReport(channelId)
        if (!database.isLoaded) return "🔒 Import your key database first: Settings → Plugins → E2EEDiscord."
        return when (ctx.getRequiredString("action")) {
            "on" -> {
                database.setChannelEncrypted(channelId, true)
                "🔒 **Encryption ON** in this channel · key: **${keyLabel(database.channelKeyHash(channelId))}**" +
                    if (!database.isUnlocked) "\n⚠️ The database is locked — unlock it in the plugin settings before sending." else ""
            }
            "off" -> {
                database.setChannelEncrypted(channelId, false)
                "🔓 **Encryption OFF** in this channel. Messages are sent normally."
            }
            "exchange" -> {
                if (!keyExchange.isDm(channelId)) return "🔑 Key exchanges happen in DMs: run this in a DM with the person."
                if (!database.isUnlocked) return "🔑 Unlock the database first (Settings → Plugins → E2EEDiscord)."
                keyExchange.startExchange(channelId, keyExchange.dmRecipient(channelId))
                "🔑 **Key exchange started.** Once they reply (they need E2EE-Discord), this DM gets its own key — " +
                    "then use `/e2ee on` to encrypt here."
            }
            "keys" -> {
                val current = database.channelKeyHash(channelId)
                val keys = database.selectableKeys(current)
                val choice = ctx.getString("key")?.trim()?.toIntOrNull()
                if (choice != null) {
                    val key = keys.getOrNull(choice - 1) ?: return "No key number $choice. Use `/e2ee keys` to see the list."
                    database.setChannelKey(channelId, key.hash)
                    "🔑 This channel now uses **${keyLabel(key.hash)}**."
                } else {
                    keys.mapIndexed { i, key ->
                        "${i + 1}. ${keyLabel(key.hash)}" + if (key.hash == current) "  ← current" else ""
                    }.joinToString("\n", "🔑 **Keys** — pick one with `/e2ee keys key:<number>`\n")
                }
            }
            else -> {
                val on = database.isChannelEncrypted(channelId)
                (if (on) "🔒 **Encryption ON**" else "🔓 **Encryption OFF**") +
                    " in this channel · key: **${keyLabel(database.channelKeyHash(channelId))}**" +
                    (if (database.isUnlocked) "" else "\n⚠️ Database locked.") +
                    "\nStart a message with `ENC` or `NOENC` to override for one message."
            }
        }
    }

    private fun keyLabel(hash: String?): String {
        if (hash == null) return "none"
        if (hash == database.personalKeyHash) return "your personal key"
        val name = database.keyName(hash).orEmpty()
        val readable = Pattern.compile("<#(\\d+)>").matcher(
            Pattern.compile("<@!?(\\d+)>").matcher(name).replaceAll("@$1"),
        ).replaceAll("#$1")
        return readable.ifEmpty { hash.take(8) }
    }
}
