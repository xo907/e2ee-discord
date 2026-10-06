/*
 * E2EE-Discord for Aliucord — Made by XO.ST
 * https://github.com/xo907/e2ee-discord
 * SPDX-License-Identifier: LGPL-3.0-or-later
 */

package st.xo.e2eediscord

import android.content.ContentResolver
import android.net.Uri
import com.lytefast.flexinput.model.Attachment
import java.io.File
import java.io.FileOutputStream
import javax.crypto.Cipher
import javax.crypto.CipherOutputStream
import javax.crypto.spec.IvParameterSpec
import javax.crypto.spec.SecretKeySpec

/**
 * Replaces the files of an outgoing message with encrypted copies (IV ‖ AES-256-CBC, same as
 * desktop) named AES(name) in base64url. Discord then uploads the copies like any other file.
 */
internal class AttachmentEncryptor(private val uploadDir: File) {
    companion object {
        private const val MAX_AGE_MS = 24L * 60 * 60 * 1000
    }

    /** True if every attachment is already one of our encrypted copies (Discord retrying a send) */
    fun isEncrypted(attachments: List<Attachment<*>>) = attachments.all { isOurs(it.uri) }

    private fun isOurs(uri: Uri?) =
        uri?.scheme == "file" && uri.path?.let { File(it).parentFile?.canonicalPath } == uploadDir.canonicalPath

    /** Encrypts every attachment; throws if any of them can't be, so nothing is sent unencrypted */
    fun encrypt(resolver: ContentResolver, attachments: List<Attachment<*>>, key: ByteArray): List<Attachment<*>> {
        uploadDir.mkdirs()
        prune()
        val created = ArrayList<File>()
        try {
            return attachments.map { attachment ->
                if (isOurs(attachment.uri)) return@map attachment
                val name = (if (attachment.spoiler) "SPOILER_" else "") + (attachment.displayName ?: "file")
                val target = File(uploadDir, "upload-" + java.util.UUID.randomUUID())
                created.add(target)
                val input = resolver.openInputStream(attachment.uri)
                    ?: throw IllegalStateException("can't read ${attachment.displayName}")
                input.use { source ->
                    val iv = Protocol.randomBytes(16)
                    val cipher = Cipher.getInstance("AES/CBC/PKCS5Padding")
                    cipher.init(Cipher.ENCRYPT_MODE, SecretKeySpec(key, "AES"), IvParameterSpec(iv))
                    FileOutputStream(target).use { output ->
                        output.write(iv)
                        CipherOutputStream(output, cipher).use { encrypted -> source.copyTo(encrypted, 64 * 1024) }
                    }
                }
                // spoiler is folded into the encrypted name, and the name has no extension so the
                // upload is sent as application/octet-stream
                Attachment(attachment.id, Uri.fromFile(target), Protocol.encryptFileName(key, name), target, false)
            }
        } catch (e: Throwable) {
            created.forEach { it.delete() }
            throw e
        }
    }

    /** Removes encrypted copies of messages that were sent (or abandoned) a while ago */
    private fun prune() {
        val cutoff = System.currentTimeMillis() - MAX_AGE_MS
        uploadDir.listFiles()?.forEach { if (it.lastModified() < cutoff) it.delete() }
    }

    fun clear() {
        uploadDir.listFiles()?.forEach { it.delete() }
    }
}
