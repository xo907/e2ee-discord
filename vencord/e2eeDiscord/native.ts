/*
 * E2EE-Discord for Vencord — Made by XO.ST
 * https://github.com/xo907/e2ee-discord
 * SPDX-License-Identifier: LGPL-3.0-or-later
 */

// Runs in Discord's main process. Discord's CDN doesn't allow the page to read attachments
// (no CORS headers), so encrypted files are downloaded here and handed to the plugin.

import { IpcMainInvokeEvent } from "electron";

const allowedUrl = /^https:\/\/(?:cdn\.discordapp\.com|media\.discordapp\.net|raw\.githubusercontent\.com\/xo907\/e2ee-discord)\//;

export async function fetchBinary(_: IpcMainInvokeEvent, url: string): Promise<Uint8Array> {
    if (typeof url !== "string" || !allowedUrl.test(url)) throw new Error("E2EE-Discord: host not allowed");
    const response = await fetch(url);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return new Uint8Array(await response.arrayBuffer());
}
