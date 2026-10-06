/*
 * E2EE-Discord for Aliucord — Made by XO.ST
 * https://github.com/xo907/e2ee-discord
 * SPDX-License-Identifier: LGPL-3.0-or-later
 */

package st.xo.e2eediscord

import android.graphics.BitmapFactory
import android.media.MediaMetadataRetriever
import android.net.Uri
import android.os.Handler
import android.os.Looper
import com.aliucord.Logger
import com.discord.api.message.attachment.MessageAttachment
import com.discord.models.message.Message
import java.io.File
import java.io.FileOutputStream
import java.io.InputStream
import java.net.HttpURLConnection
import java.net.URL
import java.util.Collections
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors
import javax.crypto.Cipher
import javax.crypto.CipherInputStream
import javax.crypto.spec.IvParameterSpec
import javax.crypto.spec.SecretKeySpec

/**
 * Encrypted attachments arrive with a base64url filename and ciphertext content. This downloads and
 * decrypts them into Discord's private cache, then points the attachment at the local file so the
 * normal chat UI shows it: images and GIFs inline, videos with Discord's player, other files as a
 * download card with the real name.
 */
internal class AttachmentDecryptor(
    private val decryptor: MessageDecryptor,
    private val cacheRoot: File,
    private val logger: Logger,
    /** The key of the message's chat, for attachments whose message carries no key */
    private val fallbackKey: (Message) -> ByteArray? = { null },
) {
    companion object {
        /** Media larger than this is not downloaded automatically */
        private const val AUTO_DOWNLOAD_LIMIT = 100L * 1024 * 1024

        // MessageAttachment decides image / video / file from these in its URL, so the local
        // file keeps the real extension
        val imageExtensions = setOf("png", "apng", "jpg", "jpeg", "jpe", "jfif", "gif", "webp", "bmp")
        val videoExtensions = setOf("mp4", "m4v", "mov", "webm", "mkv", "3gp")

        fun extensionOf(name: String) = name.substringAfterLast('.', "").lowercase()
    }

    private val executor = Executors.newFixedThreadPool(2)
    private val mainHandler = Handler(Looper.getMainLooper())
    private val inProgress = Collections.synchronizedSet(HashSet<Long>())

    private fun field(name: String) = MessageAttachment::class.java.getDeclaredField(name).apply { isAccessible = true }
    private val fFilename by lazy { field("filename") }
    private val fUrl by lazy { field("url") }
    private val fProxyUrl by lazy { field("proxyUrl") }
    private val fWidth by lazy { field("width") }
    private val fHeight by lazy { field("height") }
    private val fSize by lazy { field("size") }
    private val fId by lazy { field("id") }

    /** An encrypted attachment we recognised: where it really lives and how to open it */
    private class Known(
        val url: String,
        val proxyUrl: String?,
        val size: Long,
        val key: ByteArray,
        @Volatile var name: String,
        @Volatile var target: File,
        /** The name couldn't be decrypted: the type is worked out from the decrypted content */
        val nameUnknown: Boolean = false,
    )

    private val known = ConcurrentHashMap<Long, Known>()

    /** What happened to recently shown attachments, for /e2ee debug */
    private val status = Collections.synchronizedMap(object : LinkedHashMap<Long, String>() {
        override fun removeEldestEntry(eldest: MutableMap.MutableEntry<Long, String>?) = size > 15
    })

    private fun note(id: Long, text: String) {
        synchronized(status) {
            status.remove(id)
            status[id] = text
        }
    }

    fun debugReport(): String = synchronized(status) {
        if (status.isEmpty()) "No attachments seen yet — scroll to one."
        else status.entries.reversed().joinToString("\n") { (id, text) -> "• …${id.toString().takeLast(5)}: $text" }
    }

    /** Failed downloads are retried when shown again after this long */
    private val retryAfterMs = 20_000L
    private val failedAt = ConcurrentHashMap<Long, Long>()

    private fun idOf(attachment: MessageAttachment) = fId.getLong(attachment)

    /** True if this is an encrypted attachment we can decrypt */
    fun isOurs(attachment: MessageAttachment) = known.containsKey(idOf(attachment))

    /** True once the attachment points at its decrypted file */
    fun isDecrypted(attachment: MessageAttachment) = localFile(attachment)?.isFile == true

    private fun localFile(attachment: MessageAttachment): File? =
        (fUrl.get(attachment) as String?)?.takeIf { it.startsWith("file:") }?.let { Uri.parse(it).path }?.let(::File)

    fun displayName(attachment: MessageAttachment): String = fFilename.get(attachment) as String? ?: "file"

    /** True for decrypted images and videos, which Discord's own viewer can open */
    fun isViewableMedia(attachment: MessageAttachment) =
        isDecrypted(attachment) && extensionOf(displayName(attachment)).let { it in imageExtensions || it in videoExtensions }

    /**
     * Prepares an attachment of [message] for display. Must be called on the main thread.
     * [onReady] runs (on the main thread) when a download finished and the list should refresh.
     */
    fun prepare(message: Message, attachment: MessageAttachment, onReady: () -> Unit) {
        val id = idOf(attachment)
        val existing = known[id]
        if (existing != null) {
            if (isDecrypted(attachment)) return
            if (existing.target.isFile) {
                show(attachment, existing.name, existing.target)
                note(id, "${existing.name}: shown from cache")
                return
            }
            // not decrypted yet, or the decrypted copy was cleared: point back at the original
            fUrl.set(attachment, existing.url)
            fProxyUrl.set(attachment, existing.proxyUrl)
            fSize.setLong(attachment, existing.size)
            fFilename.set(attachment, existing.name)
            autoDownload(attachment, existing, onReady)
            return
        }

        val url = fUrl.get(attachment) as String? ?: return note(id, "no URL")
        if (url.startsWith("file:")) return
        val encryptedName = fFilename.get(attachment) as String? ?: return note(id, "no file name")
        if (encryptedName.contains('.')) return note(id, "\"${encryptedName.take(30)}\" isn't encrypted (has an extension)")
        val content = message.content
        var key = decryptor.keyFor(content)
        if (key == null && decryptor.keyHashOf(content) == null) {
            // files sent by 0.4.0–0.4.2 on Android went out without the key marker: try this chat's key
            key = fallbackKey(message)?.takeIf { Protocol.decryptFileName(it, encryptedName) != null }
        }
        if (key == null) {
            return note(id, "\"${encryptedName.take(12)}…\": " + if (decryptor.keyHashOf(content) == null) "message text isn't encrypted" else "key missing or database locked")
        }
        val keyHash = decryptor.keyHashOf(content)
        val name = try {
            Protocol.decryptFileNameOrThrow(key, encryptedName)
        } catch (e: Throwable) {
            note(id, "\"${encryptedName.take(12)}…\" (${encryptedName.length} chars, key ${keyHash?.take(6)}): name didn't decrypt — $e; trying the content")
            null
        }
        val size = fSize.getLong(attachment)
        val proxy = fProxyUrl.get(attachment) as String?
        if (name == null) {
            // still try the content: if it decrypts, its first bytes tell us what it is
            val entry = Known(url, proxy, size, key, "encrypted file", File(cacheRoot, "$id/content"), nameUnknown = true)
            known[id] = entry
            // decrypted in an earlier session already?
            File(cacheRoot, id.toString()).listFiles()?.firstOrNull { it.isFile && it.name.startsWith("file.") }?.let {
                entry.name = it.name
                entry.target = it
                show(attachment, it.name, it)
                return
            }
            fFilename.set(attachment, entry.name)
            if (size <= AUTO_DOWNLOAD_LIMIT) download(id, entry, retry = false) { ok -> if (ok) { show(attachment, entry.name, entry.target); onReady() } }
            return
        }

        val entry = Known(url, proxy, size, key, name, File(cacheRoot, "$id/${safeFileName(name)}"))
        known[id] = entry
        if (entry.target.isFile) {
            show(attachment, name, entry.target)
            note(id, "$name: shown from cache")
            return
        }
        // show the real name while it downloads
        fFilename.set(attachment, name)
        autoDownload(attachment, entry, onReady)
    }

    /** Images and videos are decrypted straight away; other files when they're opened */
    private fun autoDownload(attachment: MessageAttachment, entry: Known, onReady: () -> Unit) {
        val id = idOf(attachment)
        val extension = extensionOf(entry.name)
        val isMedia = extension in imageExtensions || extension in videoExtensions
        if (!isMedia && !entry.nameUnknown) return note(id, "${entry.name}: file, decrypted when tapped")
        if (entry.size > AUTO_DOWNLOAD_LIMIT) return note(id, "${entry.name}: too big to load automatically, tap to open")
        download(id, entry, retry = false) { ok ->
            if (ok) {
                show(attachment, entry.name, entry.target)
                onReady()
            }
        }
    }

    /** Decrypts the attachment if needed and hands back the plaintext file (null on failure), on the main thread */
    fun fetchFile(attachment: MessageAttachment, onDone: (File?, String) -> Unit) {
        val id = idOf(attachment)
        val entry = known[id] ?: return onDone(null, displayName(attachment))
        if (entry.target.isFile) {
            show(attachment, entry.name, entry.target)
            onDone(entry.target, entry.name)
            return
        }
        download(id, entry, retry = true) { ok ->
            if (ok) show(attachment, entry.name, entry.target)
            onDone(entry.target.takeIf { ok }, entry.name)
        }
    }

    fun clearCache() {
        cacheRoot.deleteRecursively()
        failedAt.clear()
    }

    /** Called with a message when a download fails, so the user hears about it once */
    var onError: ((String) -> Unit)? = null

    private val waiting = ConcurrentHashMap<Long, MutableList<(Boolean) -> Unit>>()

    private fun download(id: Long, entry: Known, retry: Boolean, onDone: (Boolean) -> Unit) {
        val lastFailure = failedAt[id]
        if (!retry && lastFailure != null && System.currentTimeMillis() - lastFailure < retryAfterMs) return
        waiting.getOrPut(id) { Collections.synchronizedList(ArrayList()) }.add(onDone)
        if (!inProgress.add(id)) return // already downloading: onDone runs when it finishes
        note(id, "${entry.name}: downloading…")
        executor.execute {
            val ok = try {
                decryptToFile(entry.url, entry.key, entry.target)
                if (entry.nameUnknown && !entry.name.startsWith("file.")) {
                    val named = File(entry.target.parentFile, "file." + sniffExtension(entry.target))
                    if (!entry.target.renameTo(named)) throw IllegalStateException("couldn't rename the decrypted file")
                    entry.target = named
                    entry.name = named.name
                }
                failedAt.remove(id)
                note(id, "${entry.name}: decrypted (${entry.target.length() / 1024} KB)")
                true
            } catch (e: Throwable) {
                val firstFailure = failedAt.put(id, System.currentTimeMillis()) == null
                note(id, "${entry.name}: FAILED — $e")
                logger.error("Couldn't download or decrypt attachment $id (${entry.name})", e)
                if (firstFailure) mainHandler.post { onError?.invoke("Couldn't decrypt ${entry.name}: ${e.message ?: e}") }
                false
            } finally {
                inProgress.remove(id)
            }
            val callbacks = waiting.remove(id) ?: return@execute
            mainHandler.post { synchronized(callbacks) { callbacks.toList() }.forEach { it(ok) } }
        }
    }

    /** Streams the download through AES-CBC (IV = first 16 bytes) into [target] */
    private fun decryptToFile(url: String, key: ByteArray, target: File) {
        val connection = URL(url).openConnection() as HttpURLConnection
        connection.connectTimeout = 20_000
        connection.readTimeout = 60_000
        connection.instanceFollowRedirects = true
        connection.setRequestProperty("User-Agent", "Mozilla/5.0 (Linux; Android) E2EE-Discord")
        try {
            if (connection.responseCode !in 200..299) throw IllegalStateException("HTTP ${connection.responseCode}")
            connection.inputStream.use { input ->
                val iv = readFully(input, 16)
                val cipher = Cipher.getInstance("AES/CBC/PKCS5Padding")
                cipher.init(Cipher.DECRYPT_MODE, SecretKeySpec(key, "AES"), IvParameterSpec(iv))
                target.parentFile?.mkdirs()
                val temp = File(target.parentFile, target.name + ".part")
                try {
                    CipherInputStream(input, cipher).use { decrypted ->
                        FileOutputStream(temp).use { output -> decrypted.copyTo(output, 64 * 1024) }
                    }
                    if (!temp.renameTo(target)) throw IllegalStateException("couldn't save ${target.name}")
                } finally {
                    temp.delete()
                }
            }
        } finally {
            connection.disconnect()
        }
    }

    /** Recognises common media from its first bytes */
    private fun sniffExtension(file: File): String {
        val head = ByteArray(16)
        val n = file.inputStream().use { it.read(head) }
        fun at(offset: Int, vararg bytes: Int) = n >= offset + bytes.size && bytes.indices.all { head[offset + it] == bytes[it].toByte() }
        fun ascii(offset: Int, text: String) = at(offset, *text.map { it.code }.toIntArray())
        return when {
            at(0, 0xFF, 0xD8, 0xFF) -> "jpg"
            at(0, 0x89, 0x50, 0x4E, 0x47) -> "png"
            ascii(0, "GIF8") -> "gif"
            ascii(0, "RIFF") && ascii(8, "WEBP") -> "webp"
            ascii(0, "RIFF") && ascii(8, "WAVE") -> "wav"
            ascii(4, "ftypqt") -> "mov"
            ascii(4, "ftypM4A") -> "m4a"
            ascii(4, "ftyp") -> "mp4"
            at(0, 0x1A, 0x45, 0xDF, 0xA3) -> "webm"
            ascii(0, "ID3") || (n >= 2 && head[0] == 0xFF.toByte() && (head[1].toInt() and 0xE0) == 0xE0) -> "mp3"
            ascii(0, "OggS") -> "ogg"
            ascii(0, "fLaC") -> "flac"
            ascii(0, "%PDF") -> "pdf"
            ascii(0, "PK") -> "zip"
            else -> "bin"
        }
    }

    private fun readFully(input: InputStream, count: Int): ByteArray {
        val buffer = ByteArray(count)
        var read = 0
        while (read < count) {
            val n = input.read(buffer, read, count - read)
            if (n < 0) throw IllegalStateException("file is too short")
            read += n
        }
        return buffer
    }

    /** Points the attachment at the decrypted file and fills in what Discord needs to show it inline */
    private fun show(attachment: MessageAttachment, name: String, file: File) {
        val uri = Uri.fromFile(file).toString()
        fFilename.set(attachment, name)
        fUrl.set(attachment, uri)
        fProxyUrl.set(attachment, uri)
        fSize.setLong(attachment, file.length())

        val extension = extensionOf(name)
        val size: Pair<Int, Int>? = try {
            when (extension) {
                in imageExtensions -> BitmapFactory.Options().run {
                    inJustDecodeBounds = true
                    BitmapFactory.decodeFile(file.path, this)
                    if (outWidth > 0 && outHeight > 0) outWidth to outHeight else null
                }
                in videoExtensions -> MediaMetadataRetriever().run {
                    try {
                        setDataSource(file.path)
                        val w = extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_WIDTH)?.toIntOrNull() ?: 0
                        val h = extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_HEIGHT)?.toIntOrNull() ?: 0
                        val rotation = extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_ROTATION)?.toIntOrNull() ?: 0
                        when {
                            w <= 0 || h <= 0 -> null
                            rotation == 90 || rotation == 270 -> h to w
                            else -> w to h
                        }
                    } finally {
                        release()
                    }
                }
                else -> null
            }
        } catch (e: Throwable) {
            null
        }
        fWidth.set(attachment, size?.first)
        fHeight.set(attachment, size?.second)
    }

    private fun safeFileName(name: String): String {
        val cleaned = String(CharArray(name.length) { i ->
            val c = name[i]
            if (c in 'A'..'Z' || c in 'a'..'z' || c in '0'..'9' || c == '.' || c == '_' || c == ' ' || c == '-') c else '_'
        }).trim().trimStart('.')
        return cleaned.ifEmpty { "file" }.take(120)
    }
}
