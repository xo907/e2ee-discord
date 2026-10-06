version = "0.4.4" // Increment to push an update to installed copies
description = "End-to-end encrypted messages, compatible with E2EE-Discord on desktop. Made by XO.ST"

aliucord {
    changelog.set(
        """
        # 0.4.4
        * Fix: text sent from the phone could be encrypted twice (showing ciphertext instead of your message).
          Decrypted text is now shown through a private copy of each message and never touches Discord's stored messages,
          and each message is encrypted exactly once.
        * /e2ee debug lists what happened to recent sends.

        # 0.4.3
        * Fix: photos and files sent from the phone went out without the encrypted key marker, so no device could open them.
          Message text is now encrypted when Discord queues the send.
        * Fix: garbled emoji in /e2ee replies.

        # 0.4.2
        * Encrypted media shows even when its file name can't be decrypted: the type is detected from the decrypted content.
        * /e2ee debug shows the exact error and runs a name-encryption self-test.

        # 0.4.1
        * /e2ee debug shows what happened to recent attachments (to track down media that doesn't show).
        * Failed media downloads show an error and are retried; tap a file to retry right away.
        * Each part of the plugin starts independently, so one failing hook can't disable the rest.

        # 0.4.0
        * Phase 4: encrypted files. Files sent while encryption is on are encrypted, names included.
        * Encrypted images, GIFs and videos are decrypted and shown in chat.
        * Tap other encrypted files (music, documents…) to decrypt them to Downloads and open them.
        * "Delete decrypted files" in the plugin settings.

        # 0.3.0
        * Phase 3: key exchange. New DM keys, personal keys and shared keys are learned automatically.
        * /e2ee exchange starts a secure DM key exchange from the phone.
        * Optional "Answer key exchanges from this phone" setting for when you don't use a computer.

        # 0.2.0
        * Phase 2: send and edit encrypted messages. Use /e2ee on, /e2ee off, /e2ee status and /e2ee keys.
        * Editing an encrypted message shows its plaintext and re-encrypts the edit with the same key.
        * In encrypted channels, file uploads are blocked until encrypted files are supported.

        # 0.1.0
        * Phase 1: read encrypted E2EE-Discord / SimpleDiscordCrypt messages using a key database exported from desktop.
        """.trimIndent(),
    )

    // Distributed from this repository (dist/ and the Actions artifact), not Aliucord's plugin repositories
    deploy.set(false)
}
