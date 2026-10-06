// ==UserScript==
// @name         E2EE-Discord
// @namespace    https://github.com/xo907/e2ee-discord
// @version      {{VERSION}}
// @description  End-to-end encryption for Discord messages and files, with automatic key exchange. Made by XO.ST
// @author       XO.ST
// @license      LGPL-3.0-or-later
// @homepageURL  https://github.com/xo907/e2ee-discord
// @supportURL   https://github.com/xo907/e2ee-discord/issues
// @downloadURL  https://raw.githubusercontent.com/xo907/e2ee-discord/main/dist/E2EE-Discord.user.js
// @updateURL    https://raw.githubusercontent.com/xo907/e2ee-discord/main/dist/E2EE-Discord.meta.js
// @icon         https://raw.githubusercontent.com/xo907/e2ee-discord/main/assets/logo-128.png
// @match        https://discord.com/*
// @match        https://ptb.discord.com/*
// @match        https://canary.discord.com/*
// @exclude      https://discord.com/developers*
// @exclude      https://discord.com/oauth2*
// @exclude      https://discord.com/api/*
// @run-at       document-start
// @inject-into  page
// @sandbox      JavaScript
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_xmlhttpRequest
// @grant        unsafeWindow
// @connect      raw.githubusercontent.com
// @connect      cdn.discordapp.com
// @connect      media.discordapp.net
// ==/UserScript==
