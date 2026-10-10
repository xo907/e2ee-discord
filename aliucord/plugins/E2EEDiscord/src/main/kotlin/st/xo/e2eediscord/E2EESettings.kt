/*
 * E2EE-Discord for Aliucord — Made by XO.ST
 * https://github.com/xo907/e2ee-discord
 * SPDX-License-Identifier: LGPL-3.0-or-later
 */

package st.xo.e2eediscord

import android.annotation.SuppressLint
import android.os.Environment
import android.os.Handler
import android.os.Looper
import android.text.InputType
import android.view.View
import android.widget.TextView
import com.aliucord.Constants
import com.aliucord.Utils
import com.aliucord.fragments.SettingsPage
import com.aliucord.utils.DimenUtils
import com.aliucord.views.Button
import com.aliucord.views.DangerButton
import com.aliucord.views.TextInput
import com.discord.views.CheckedSetting
import com.lytefast.flexinput.R
import java.io.File

class E2EESettings(private val plugin: E2EEDiscord) : SettingsPage() {
    @SuppressLint("SetTextI18n")
    override fun onViewBound(view: View) {
        super.onViewBound(view)
        setActionBarTitle("E2EE-Discord")
        val context = requireContext()
        val database = plugin.database

        addHeader(context, "E2EE-Discord · Made by XO.ST")
        addText(
            when {
                !database.isLoaded -> "No key database yet. Import the one from your computer below."
                !database.isUnlocked -> "Database imported (${database.keyCount} keys) — locked. Enter its password below."
                else -> "Ready: ${database.keyCount} keys. Encrypted messages are decrypted automatically."
            },
        )
        addText(
            "Send encrypted messages: type /e2ee on in a chat (and /e2ee off to stop). /e2ee keys picks the key, " +
                "/e2ee status shows the current setting. Start one message with ENC or NOENC to override.",
        )
        addText(
            "Files you send while encryption is on are encrypted too. Encrypted images, GIFs and videos " +
                "show in chat; tap any other file (music, documents…) to decrypt it to Downloads and open it.",
            subtle = true,
        )

        // key exchanges
        addHeader(context, "Key exchanges")
        addView(
            Utils.createCheckedSetting(
                context,
                CheckedSetting.ViewType.SWITCH,
                "Answer key exchanges from this phone",
                "Turn this on if you don't run E2EE-Discord on a computer. When off, your computer answers " +
                    "and this phone quietly learns the new keys, so nobody gets duplicate replies.",
            ).apply {
                isChecked = plugin.settings.getBool(E2EEDiscord.SETTING_ANSWER_EXCHANGES, false)
                setOnCheckedListener { checked -> plugin.settings.setBool(E2EEDiscord.SETTING_ANSWER_EXCHANGES, checked) }
            },
        )
        addText(
            "Use /e2ee exchange in a DM to set up a secure DM key from this phone. When answering is on, " +
                "the phone also asks people for keys it's missing (asking you first unless they're a friend " +
                "and auto key exchange with friends is on in your desktop settings).",
            subtle = true,
        )

        // unlock
        if (database.isLoaded && !database.isUnlocked) {
            addHeader(context, "Unlock")
            val passwordInput = TextInput(context, "Database password").apply {
                editText.inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_PASSWORD
            }
            addView(passwordInput)
            addView(
                Button(context).apply {
                    text = "Unlock"
                    setOnClickListener {
                        val password = passwordInput.editText.text?.toString().orEmpty()
                        val mainHandler = Handler(Looper.getMainLooper())
                        isEnabled = false
                        text = "Unlocking…"
                        // checking the password of a 3.0 database takes a second or two
                        Thread {
                            val failure = try {
                                if (database.unlock(password)) null else "Wrong password"
                            } catch (e: Throwable) {
                                e.message ?: "Couldn't unlock the database"
                            }
                            mainHandler.post {
                                try {
                                    if (failure == null) {
                                        plugin.onDatabaseChanged()
                                        Utils.showToast("Unlocked — reopen a channel to see decrypted messages")
                                        reRender()
                                    } else {
                                        isEnabled = true
                                        text = "Unlock"
                                        Utils.showToast(failure, true)
                                    }
                                } catch (e: Throwable) {
                                    // the settings page was closed meanwhile
                                }
                            }
                        }.start()
                    }
                },
            )
            addText(
                "The password is never saved, so you'll unlock again after Discord restarts.",
                subtle = true,
            )
        }

        // import
        addHeader(context, if (database.isLoaded) "Re-import database" else "Import database")
        addText(
            "On your computer: right-click the lock in Discord's message bar → Export Database. " +
                "Copy E2EE-Discord.dat to your phone (Downloads or the Aliucord folder), then tap Import.",
        )
        val pathInput = TextInput(context, "File to import").apply {
            editText.setText(findExport()?.absolutePath ?: "${Constants.BASE_PATH}/E2EE-Discord.dat")
        }
        addView(pathInput)
        addView(
            Button(context).apply {
                text = "Import"
                setOnClickListener {
                    val source = File(pathInput.editText.text?.toString().orEmpty().trim())
                    if (!source.isFile) {
                        Utils.showToast("File not found: ${source.absolutePath}", true)
                        return@setOnClickListener
                    }
                    try {
                        database.import(source)
                        plugin.onDatabaseChanged()
                        Utils.showToast(
                            "Imported ${database.keyCount} keys. Delete ${source.name} from your phone's storage — it contains your keys.",
                            true,
                        )
                        reRender()
                    } catch (e: Throwable) {
                        plugin.logger.error("Import failed", e)
                        Utils.showToast("Import failed: ${e.message}", true)
                    }
                }
            },
        )

        // decrypted files
        addHeader(context, "Decrypted files")
        addText(
            "Decrypted images and videos are kept in Discord's private cache so they don't download again. " +
                "Files you saved to Downloads are not affected.",
            subtle = true,
        )
        addView(
            Button(context).apply {
                text = "Delete decrypted files"
                setOnClickListener {
                    plugin.clearDecryptedFiles()
                    Utils.showToast("Decrypted files deleted")
                }
            },
        )

        // remove
        if (database.isLoaded) {
            addHeader(context, "Remove")
            addView(
                DangerButton(context).apply {
                    text = "Remove key database from this phone"
                    setOnClickListener {
                        database.delete()
                        plugin.clearDecryptedFiles()
                        plugin.onDatabaseChanged()
                        Utils.showToast("Key database removed")
                        reRender()
                    }
                },
            )
        }
    }

    private fun addText(text: String, subtle: Boolean = false) {
        addView(
            TextView(requireContext(), null, 0, if (subtle) R.i.UiKit_TextView_Subtext else R.i.UiKit_TextView).apply {
                this.text = text
                val padding = DimenUtils.dpToPx(16)
                setPadding(padding, DimenUtils.dpToPx(4), padding, DimenUtils.dpToPx(8))
            },
        )
    }

    /** Looks for an exported database in the usual places */
    private fun findExport(): File? {
        val downloads = Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS)
        val folders = listOf(File(Constants.BASE_PATH), downloads)
        val names = listOf("E2EE-Discord.dat", "E2EE-Discord.json", "SimpleDiscordCrypt.dat", "SimpleDiscordCrypt.json")
        for (folder in folders) for (name in names) {
            val candidate = File(folder, name)
            if (candidate.isFile) return candidate
        }
        return null
    }
}
