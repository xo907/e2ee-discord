/*
 * E2EE-Discord for Aliucord — Made by XO.ST
 * https://github.com/xo907/e2ee-discord
 * SPDX-License-Identifier: LGPL-3.0-or-later
 */

package st.xo.e2eediscord

import android.content.ContentValues
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.provider.MediaStore
import android.webkit.MimeTypeMap
import java.io.File
import java.io.FileInputStream

/** Copies decrypted files to the public Downloads folder and opens them */
internal object FileSaver {
    fun mimeType(name: String): String =
        MimeTypeMap.getSingleton().getMimeTypeFromExtension(AttachmentDecryptor.extensionOf(name)) ?: "application/octet-stream"

    /** @return a URI other apps can open (Android 10+), or null when only the file path is available */
    fun saveToDownloads(context: Context, file: File, name: String): Uri? {
        val displayName = name.removePrefix("SPOILER_").replace('/', '_').ifBlank { "file" }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            val values = ContentValues().apply {
                put(MediaStore.MediaColumns.DISPLAY_NAME, displayName)
                put(MediaStore.MediaColumns.MIME_TYPE, mimeType(displayName))
                put(MediaStore.MediaColumns.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS)
            }
            val resolver = context.contentResolver
            val uri = resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values)
                ?: throw IllegalStateException("couldn't create the file in Downloads")
            try {
                (resolver.openOutputStream(uri) ?: throw IllegalStateException("couldn't write to Downloads")).use { output ->
                    FileInputStream(file).use { it.copyTo(output, 64 * 1024) }
                }
            } catch (e: Throwable) {
                resolver.delete(uri, null, null)
                throw e
            }
            return uri
        }
        @Suppress("DEPRECATION")
        val folder = Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS)
        folder.mkdirs()
        var target = File(folder, displayName)
        var n = 1
        while (target.exists()) target = File(folder, displayName.substringBeforeLast('.') + " (${n++})" +
            displayName.substringAfterLast('.', "").let { if (it.isEmpty()) "" else ".$it" })
        file.copyTo(target)
        return null
    }

    /** Opens a saved file in another app; false if no app can open it */
    fun open(context: Context, uri: Uri, name: String): Boolean = try {
        val intent = Intent(Intent.ACTION_VIEW)
            .setDataAndType(uri, mimeType(name))
            .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
        context.startActivity(intent)
        true
    } catch (e: Throwable) {
        false
    }
}
