/*
 * E2EE-Discord for Aliucord — Made by XO.ST
 * https://github.com/xo907/e2ee-discord
 * SPDX-License-Identifier: LGPL-3.0-or-later
 *
 * Wire format shared with the desktop plugin. See PROTOCOL.md in the repository root.
 */

package st.xo.e2eediscord

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.ColorSpace
import android.os.Build
import android.util.Base64
import java.io.ByteArrayOutputStream
import java.security.MessageDigest
import java.security.SecureRandom
import java.util.regex.Pattern
import javax.crypto.Cipher
import javax.crypto.Mac
import javax.crypto.spec.IvParameterSpec
import javax.crypto.spec.SecretKeySpec

internal object Protocol {
    // java.util.regex rather than kotlin.text.Regex: Discord ships an obfuscated Kotlin stdlib

    /** Payload (braille-encoded bytes) followed by our tag line, or the legacy SimpleDiscordCrypt tag. Group 1 is the payload. */
    val messagePattern: Pattern = Pattern.compile(
        """^([⠀-⣿]{16,})(?:[ \t]*`(?:SimpleDiscordCrypt|𝘚𝘪𝘮𝘱𝘭𝘦𝘋𝘪𝘴𝘤𝘰𝘳𝘥𝘊𝘳𝘺𝘱𝘵)`|\s+[^\n]*e2ee-discord[^\n]*)$""",
        Pattern.CASE_INSENSITIVE,
    )

    /** Key-exchange ("system") messages. Group 1 is the body. */
    val systemMessagePattern: Pattern = Pattern.compile(
        """^```(?:\w*\n)?-----SYSTEM MESSAGE-----\n?```\s*(.*?)\s*(?:```(?:\w*\n)?(?:𝘚𝘪𝘮𝘱𝘭𝘦𝘋𝘪𝘴𝘤𝘰𝘳𝘥𝘊𝘳𝘺𝘱𝘵|SimpleDiscordCrypt)\n?```|[^\n]*e2ee-discord[^\n]*)$""",
        Pattern.CASE_INSENSITIVE or Pattern.DOTALL,
    )

    /** Every byte b is carried as the character U+2800 + b. */
    fun payloadDecode(payload: String): ByteArray =
        ByteArray(payload.length) { i -> (payload[i].code - 0x2800).toByte() }

    fun payloadEncode(bytes: ByteArray): String =
        String(CharArray(bytes.size) { i -> (0x2800 + (bytes[i].toInt() and 0xff)).toChar() })

    fun base64(bytes: ByteArray): String = Base64.encodeToString(bytes, Base64.NO_WRAP)

    fun fromBase64(text: String): ByteArray = Base64.decode(text, Base64.DEFAULT)

    fun sha512(bytes: ByteArray): ByteArray = MessageDigest.getInstance("SHA-512").digest(bytes)

    /** The id of a key: the first 16 bytes of its SHA-512, base64-encoded. */
    fun keyHash(rawKey: ByteArray): String = base64(sha512(rawKey).copyOf(16))

    /** AES-256-CBC with the 16-byte IV prepended to the ciphertext (PKCS#7 padding). */
    fun aesDecrypt(key: ByteArray, data: ByteArray): ByteArray {
        require(data.size >= 32 && data.size % 16 == 0) { "invalid ciphertext length" }
        val cipher = Cipher.getInstance("AES/CBC/PKCS5Padding")
        cipher.init(Cipher.DECRYPT_MODE, SecretKeySpec(key, "AES"), IvParameterSpec(data, 0, 16))
        return cipher.doFinal(data, 16, data.size - 16)
    }

    private val random = SecureRandom()

    fun randomBytes(count: Int) = ByteArray(count).also { random.nextBytes(it) }

    /** AES-256-CBC with a random IV, returned as IV ‖ ciphertext */
    fun aesEncrypt(key: ByteArray, data: ByteArray): ByteArray {
        val iv = randomBytes(16)
        val cipher = Cipher.getInstance("AES/CBC/PKCS5Padding")
        cipher.init(Cipher.ENCRYPT_MODE, SecretKeySpec(key, "AES"), IvParameterSpec(iv))
        return iv + cipher.doFinal(data)
    }

    private const val PROJECT_URL = "https://github.com/xo907/e2ee-discord"
    private const val TAG_SHORT = "[🔒](<$PROJECT_URL>)"
    private const val MESSAGE_LENGTH_LIMIT = 2000

    /* ───────────── seal (desktop 3.0) ───────────── */

    private val SEAL_INFO = "E2EE-Discord seal v1".toByteArray(Charsets.UTF_8)

    /** The seal in a message's tag line, if it has one. Group 1 is the seal. */
    val sealPattern: Pattern = Pattern.compile(
        """e2ee-discord#s=([A-Za-z0-9_-]{22})(?![A-Za-z0-9_-])""",
        Pattern.CASE_INSENSITIVE,
    )

    private fun hmac(algorithm: String, key: ByteArray, data: ByteArray): ByteArray {
        val mac = Mac.getInstance(algorithm)
        mac.init(SecretKeySpec(key, algorithm))
        return mac.doFinal(data)
    }

    /**
     * HMAC-SHA-256 over the payload bytes, cut to 16 bytes, as unpadded base64url. The MAC key is
     * HKDF-SHA-256(message key, no salt, info "E2EE-Discord seal v1"), written out here as its two steps.
     */
    fun seal(key: ByteArray, payload: ByteArray): String {
        val extracted = hmac("HmacSHA256", ByteArray(32), key)
        val macKey = hmac("HmacSHA256", extracted, SEAL_INFO + byteArrayOf(1))
        return Base64.encodeToString(
            hmac("HmacSHA256", macKey, payload).copyOf(16),
            Base64.URL_SAFE or Base64.NO_PADDING or Base64.NO_WRAP,
        )
    }

    /** False only if [content] carries a seal that doesn't fit. Messages without one (2.x clients) pass. */
    fun sealMatches(key: ByteArray, payload: ByteArray, content: String): Boolean {
        val matcher = sealPattern.matcher(content)
        if (!matcher.find()) return true
        return MessageDigest.isEqual(
            seal(key, payload).toByteArray(Charsets.UTF_8),
            matcher.group(1)!!.toByteArray(Charsets.UTF_8),
        )
    }

    /**
     * PBKDF2-HMAC-SHA-512 for the database password (desktop 3.0 vaults), up to one block (64 bytes).
     * Written out because the platform's version treats non-ASCII passwords differently between Android releases.
     */
    fun pbkdf2Sha512(password: ByteArray, salt: ByteArray, iterations: Int, length: Int): ByteArray {
        require(length in 1..64 && iterations >= 1) { "invalid PBKDF2 parameters" }
        val mac = Mac.getInstance("HmacSHA512")
        mac.init(SecretKeySpec(password, "HmacSHA512"))
        mac.update(salt)
        var block = mac.doFinal(byteArrayOf(0, 0, 0, 1))
        val out = block.copyOf()
        for (i in 1 until iterations) {
            block = mac.doFinal(block)
            for (j in out.indices) out[j] = (out[j].toInt() xor block[j].toInt()).toByte()
        }
        return out.copyOf(length)
    }

    /** Prefixes that force encryption / plain text for a single message (same as desktop) */
    val encryptPrefix: Pattern = Pattern.compile("""^(?::?ENC(?:(?:_\w*)?:|\b)|<:ENC:\d{1,20}>)\s*""")
    val noEncryptPrefix: Pattern = Pattern.compile("""^(?::?NOENC:?|<:NOENC:\d{1,20}>)\s*""")

    /** Builds the message content: braille(keyHash ‖ AES(compress(text))) + tag line carrying the seal */
    fun encryptMessage(keyHashBase64: String, key: ByteArray, text: String): String {
        val keyHashBytes = fromBase64(keyHashBase64)
        val bytes = if (text.isEmpty()) keyHashBytes
        else keyHashBytes + aesEncrypt(key, tryCompress(text.toByteArray(Charsets.UTF_8)))
        val payload = payloadEncode(bytes)
        val tag = seal(key, bytes)
        val full = "$payload\n-# 🔒 Encrypted with [E2EE-Discord](<$PROJECT_URL#s=$tag>)"
        if (full.length <= MESSAGE_LENGTH_LIMIT) return full
        val short = "$payload [🔒](<$PROJECT_URL#s=$tag>)"
        // at the very limit, sending without a seal beats not sending
        return if (short.length <= MESSAGE_LENGTH_LIMIT) short else "$payload $TAG_SHORT"
    }

    private const val FILENAME_LIMIT = 47
    private val filenameParts: Pattern = Pattern.compile("""^(.*?)((?:\.[^.]*)?)$""", Pattern.DOTALL)

    /**
     * Attachment names are AES(name) as unpadded base64url. Like desktop, the name is shortened to
     * 47 characters (keeping the extension), and Discord's trimming of '_' at either end is avoided.
     */
    fun encryptFileName(key: ByteArray, fileName: String): String {
        val parts = filenameParts.matcher(fileName)
        val (base, extension) = if (parts.matches()) parts.group(1)!! to parts.group(2)!! else fileName to ""
        val maxBase = (FILENAME_LIMIT - extension.length).coerceAtLeast(0)
        var bytes = ((if (base.length > maxBase) base.substring(0, maxBase) else base) + extension).toByteArray(Charsets.UTF_8)
        if (bytes.size > FILENAME_LIMIT) bytes = "file$extension".toByteArray(Charsets.UTF_8)
        while (true) {
            val encrypted = Base64.encodeToString(aesEncrypt(key, bytes), Base64.URL_SAFE or Base64.NO_PADDING or Base64.NO_WRAP)
            if (!encrypted.startsWith("_") && !encrypted.endsWith("_")) return encrypted
        }
    }

    fun decryptFileName(key: ByteArray, encrypted: String): String? = try {
        decryptFileNameOrThrow(key, encrypted)
    } catch (e: Throwable) {
        null
    }

    fun decryptFileNameOrThrow(key: ByteArray, encrypted: String): String {
        // base64url without padding, decoded by hand so nothing depends on platform flag quirks
        val standard = StringBuilder(encrypted.trim().replace('-', '+').replace('_', '/'))
        while (standard.length % 4 != 0) standard.append('=')
        val bytes = Base64.decode(standard.toString(), Base64.DEFAULT)
        val name = String(aesDecrypt(key, bytes), java.nio.charset.StandardCharsets.UTF_8)
        if (name.trim().isEmpty()) throw IllegalArgumentException("empty name")
        return name
    }

    /**
     * Counterpart of [tryDecompress]:data of 1600+ bytes is packed 3 bytes per RGB pixel into a PNG
     * (rows of up to 32767 pixels) and the first 6 bytes become 05 DC + length (uint32 LE).
     */
    fun tryCompress(data: ByteArray): ByteArray {
        val length = data.size
        if (length < 1600) return data
        val pixelCount = (length + 2) / 3
        val lines = (pixelCount + 32766) / 32767
        val width = (pixelCount + lines - 1) / lines

        val pixels = IntArray(width * lines) { 0xff000000.toInt() }
        for (i in 0 until pixelCount) {
            val o = i * 3
            val r = data[o].toInt() and 0xff
            val g = if (o + 1 < length) data[o + 1].toInt() and 0xff else 0
            val b = if (o + 2 < length) data[o + 2].toInt() and 0xff else 0
            pixels[i] = (0xff shl 24) or (r shl 16) or (g shl 8) or b
        }
        val bitmap = Bitmap.createBitmap(width, lines, Bitmap.Config.ARGB_8888)
        try {
            bitmap.setPixels(pixels, 0, width, 0, 0, width, lines)
            val out = ByteArrayOutputStream()
            if (!bitmap.compress(Bitmap.CompressFormat.PNG, 100, out)) return data
            val png = out.toByteArray()
            png[0] = 0x05
            png[1] = 0xDC.toByte()
            png[2] = length.toByte()
            png[3] = (length shr 8).toByte()
            png[4] = (length shr 16).toByte()
            png[5] = (length shr 24).toByte()
            return png
        } finally {
            bitmap.recycle()
        }
    }

    /**
     * Messages of 1600+ bytes are packed into a PNG (3 bytes per RGB pixel) whose signature is
     * replaced by 05 DC + the original length (uint32, little-endian). Anything else is returned as is.
     */
    fun tryDecompress(data: ByteArray): ByteArray {
        if (data.size < 6 || data[0] != 0x05.toByte() || data[1] != 0xDC.toByte()) return data
        val length = (data[2].toInt() and 0xff) or
            ((data[3].toInt() and 0xff) shl 8) or
            ((data[4].toInt() and 0xff) shl 16) or
            ((data[5].toInt() and 0xff) shl 24)
        require(length >= 0) { "invalid compressed length" }

        val png = data.copyOf()
        byteArrayOf(0x89.toByte(), 0x50, 0x4E, 0x47, 0x0D, 0x0A).copyInto(png)

        val options = BitmapFactory.Options().apply {
            inPreferredConfig = Bitmap.Config.ARGB_8888
            inPremultiplied = false
            inScaled = false
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                inPreferredColorSpace = ColorSpace.get(ColorSpace.Named.SRGB)
            }
        }
        val bitmap = BitmapFactory.decodeByteArray(png, 0, png.size, options)
            ?: throw IllegalArgumentException("compressed message is not a valid image")
        try {
            val width = bitmap.width
            val height = bitmap.height
            require(width.toLong() * height * 3 >= length) { "compressed message is truncated" }
            val pixels = IntArray(width * height)
            bitmap.getPixels(pixels, 0, width, 0, 0, width, height)

            val out = ByteArray(length)
            var offset = 0
            for (pixel in pixels) {
                if (offset >= length) break
                out[offset++] = (pixel shr 16).toByte() // R
                if (offset < length) out[offset++] = (pixel shr 8).toByte() // G
                if (offset < length) out[offset++] = pixel.toByte() // B
            }
            return out
        } finally {
            bitmap.recycle()
        }
    }
}
