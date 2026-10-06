// ==UserScript==
// @name         E2EE-Discord
// @namespace    https://github.com/xo907/e2ee-discord
// @version      2.0.2
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

(function () {
/*!
 * E2EE-Discord — end-to-end encryption for Discord messages and files
 * Made by XO.ST · https://github.com/xo907/e2ee-discord
 *
 * Based on SimpleDiscordCrypt by An0 (https://gitlab.com/An0/SimpleDiscordCrypt),
 * which is licensed under the GNU LGPLv3. This file is distributed under the same license.
 *
 * This file is host-agnostic. It is wrapped by the userscript, browser extension,
 * Vencord plugin and BetterDiscord plugin builds (see build.ps1). A host may pass:
 *   host.window        the page window (defaults to unsafeWindow/window)
 *   host.storage       { get(key): Promise<any>, set(key, value): Promise<void> }
 *   host.fetchBinary   (url) => Promise<ArrayBuffer>, used when the page itself can't fetch (CSP)
 *   host.name          'userscript' | 'extension' | 'vencord' | 'betterdiscord'
 *   host.dryRun        true: never send key-exchange messages (for testing)
 */
function E2EEDiscord(host) {
  'use strict';

  host = host || {};
  const PageWindow =
    host.window || (typeof unsafeWindow !== 'undefined' ? unsafeWindow : window);

  /* ────────────────────────────── Branding ────────────────────────────── */

  const AppName = 'E2EE-Discord';
  const AppCredit = 'Made by XO.ST';
  const AppVersion = '2.0.2';
  const ProjectUrl = 'https://github.com/xo907/e2ee-discord';
  const BlacklistUrl =
    'https://raw.githubusercontent.com/xo907/e2ee-discord/main/blacklist.txt';
  const DbStorageKey = 'E2EEDiscord';
  const LegacyDbStorageKeys = ['SimpleDiscordCrypt'];
  const ExportBaseName = 'E2EE-Discord';

  const BaseColor = '#ff0000';
  const BaseColorHover = '#d60000';

  const InactiveChannelTime = 7 * 24 * 60 * 60 * 1000; //1 week
  const IgnoreDiffKeyAge = 7 * 24 * 60 * 60 * 1000;
  const DiffKeyTrigger = 10;
  const MessageLengthLimit = 2000;

  // Custom emoji used as the "decrypted" marker in front of messages. They are only
  // used for their id; the image is replaced with our own icon through CSS.
  const EncEmojiId = '465534298662109185';
  const EncOtherKeyEmojiId = '611264394747183115';

  /* ─────────────────────────────── Wire format ─────────────────────────────── */
  // Everything below must stay stable, other clients parse it.

  // Shown under every encrypted message, so people without the plugin know where to get it.
  const MessageTagLine = `-# 🔒 Encrypted with [${AppName}](<${ProjectUrl}>)`;
  const MessageTagShort = `[🔒](<${ProjectUrl}>)`;
  const SystemMessageHeader = '```ml\n-----SYSTEM MESSAGE-----\n```';
  const SystemTagLine = `-# 🔑 ${AppName} key exchange · [what is this?](<${ProjectUrl}>)`;

  // Payload (braille-encoded bytes) followed by our tag, or the legacy SimpleDiscordCrypt tag.
  const messageRegex =
    /^([⠀-⣿]{16,})(?:[ \t]*`(?:SimpleDiscordCrypt|𝘚𝘪𝘮𝘱𝘭𝘦𝘋𝘪𝘴𝘤𝘰𝘳𝘥𝘊𝘳𝘺𝘱𝘵)`|\s+[^\n]*e2ee-discord[^\n]*)$/i;
  const systemMessageRegex =
    /^```(?:\w*\n)?-----SYSTEM MESSAGE-----\n?```\s*(.*?)\s*(?:```(?:\w*\n)?(?:𝘚𝘪𝘮𝘱𝘭𝘦𝘋𝘪𝘴𝘤𝘰𝘳𝘥𝘊𝘳𝘺𝘱𝘵|SimpleDiscordCrypt)\n?```|[^\n]*e2ee-discord[^\n]*)$/is;
  const legacyFooterNames = ['SimpleDiscordCrypt', '𝘚𝘪𝘮𝘱𝘭𝘦𝘋𝘪𝘴𝘤𝘰𝘳𝘥𝘊𝘳𝘺𝘱𝘵'];

  // What plugin users see instead of messages they can't decrypt
  const unknownKeyMessage = `🔒 **Encrypted message** — you don't have the key for this one yet.\n-# Sent with [${AppName}](<${ProjectUrl}>) · ${AppCredit}`;
  const invalidMessage = `⚠️ **Encrypted message in an unknown format**\n-# [${AppName}](<${ProjectUrl}>)`;
  const unknownKeySystemMessage = '-# 🔑 Key exchange message encrypted with a key you don\'t have';
  const invalidSystemMessage = '-# ⚠️ Key exchange message in an unknown format';
  const blockedSystemMessage = '-# 🔑 Key exchange message blocked';

  /* ──────────────────────────────── Icons ──────────────────────────────── */

  const svgDataUri = (svg) => `data:image/svg+xml,${encodeURIComponent(svg)}`;

  const LogoSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128"><rect width="128" height="128" rx="28" fill="#000"/><path d="M22 41l32 46M54 41L22 87" stroke="#fff" stroke-width="13" stroke-linecap="square" fill="none"/><circle cx="88" cy="64" r="20" fill="none" stroke="#f00" stroke-width="12"/></svg>`;
  const LogoDataUri = svgDataUri(LogoSvg);
  const LockClosedSvg = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7.5 10.5V7.75a4.5 4.5 0 0 1 9 0v2.75" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/><rect x="4" y="10" width="16" height="12" rx="3" fill="currentColor"/><circle cx="12" cy="15.3" r="1.7" style="fill:#000"/><rect x="11.15" y="15.8" width="1.7" height="3.3" rx=".85" style="fill:#000"/></svg>`;
  const LockOpenSvg = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7.5 10.5V7.75a4.5 4.5 0 0 1 8.7-1.6" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/><rect x="5.1" y="11.1" width="13.8" height="9.8" rx="2.4" fill="none" stroke="currentColor" stroke-width="2.2"/><circle cx="12" cy="15.6" r="1.6" fill="currentColor"/></svg>`;
  const KeySvg = `<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="7.5" cy="12" r="4" fill="none" stroke="currentColor" stroke-width="2.4"/><path d="M11.5 12h9.5M18 12v3.5M21 12v2.5" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/></svg>`;
  const EncEmojiSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M7.5 10.5V7.75a4.5 4.5 0 0 1 9 0v2.75" fill="none" stroke="#ff0000" stroke-width="2.4" stroke-linecap="round"/><rect x="4" y="10" width="16" height="12" rx="3" fill="#ff0000"/><circle cx="12" cy="15.3" r="1.8" fill="#fff"/><rect x="11.1" y="15.8" width="1.8" height="3.4" rx=".9" fill="#fff"/></svg>`;
  const EncOtherKeyEmojiSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M7.5 10.5V7.75a4.5 4.5 0 0 1 9 0v2.75" fill="none" stroke="#9a9a9a" stroke-width="2.4" stroke-linecap="round"/><rect x="4" y="10" width="16" height="12" rx="3" fill="#fff" stroke="#555" stroke-width=".8"/><circle cx="12" cy="15.3" r="1.8" fill="#ff0000"/><rect x="11.1" y="15.8" width="1.8" height="3.4" rx=".9" fill="#ff0000"/></svg>`;

  const LogoImg = (size) =>
    `<img class="e2ee-logo" alt="" width="${size}" height="${size}" src="${LogoDataUri}">`;
  const TitleBar = (title, subtitle) =>
    `<div class="e2ee-titlebar">${LogoImg(24)}<div class="e2ee-titletext"><h4>${title}</h4>${
      subtitle ? `<p class="e2ee-sub">${subtitle}</p>` : ''
    }</div></div>`;

  const PasswordField = (autocomplete, marginBottom) =>
    `<div class="e2ee-pass" style="margin-top:8px;margin-bottom:${marginBottom}px"><input class="E2EE_PASSWORD" type="password" name="e2ee-password" autocomplete="${autocomplete}" spellcheck="false"><button type="button" class="E2EE_SHOWPASS e2ee-showpass" tabindex="-1">Show</button></div>`;

  /* ─────────────────────────────── Selectors ─────────────────────────────── */
  // Discord hashes its class names, so match on the stable prefix only.

  const ChatButtonsSelectors = [
    'main[class*="chatContent"] form [class*="channelTextArea"] [class*="buttons_"]',
    'form [class*="channelTextArea"] [class*="buttons_"]',
  ];
  const HeaderToolbarSelectors = [
    'div[class*="chat_"] section[class*="title"] [class*="toolbar"]',
    'section[class*="title"] [class*="toolbar"]',
  ];
  const ChatInputSelector = `form [class*="channelTextArea"] > [class*="scrollableContainer"]`;

  const htmlEscapeDiv = document.createElement('div');
  function HtmlEscape(string) {
    htmlEscapeDiv.textContent = string;
    return htmlEscapeDiv.innerHTML;
  }

  /* ──────────────────────────────── Styles ──────────────────────────────── */

  const Style = {
    css: `
/* decrypted-message markers */
img[src*="/emojis/${EncEmojiId}"] { content: url("${svgDataUri(EncEmojiSvg)}"); }
img[src*="/emojis/${EncOtherKeyEmojiId}"] { content: url("${svgDataUri(EncOtherKeyEmojiSvg)}"); }

/* windows */
.e2ee-ui, .e2ee-ui * { box-sizing: border-box; }
/* :where keeps this at the lowest specificity so the rules below always win */
.e2ee-ui :where(*:not(svg):not(svg *)) {
    font-family: var(--font-primary, "gg sans", "Noto Sans", "Helvetica Neue", Arial, sans-serif);
    font-size: 15px;
    font-weight: 400;
    line-height: 1.25;
    color: #fff;
    user-select: none;
    display: flex;
    padding: 0;
    margin: 0;
}
.e2ee-overlay, .e2ee-cover {
    position: fixed;
    inset: 0;
    z-index: 10000;
    align-items: center;
    justify-content: center;
    pointer-events: none;
}
.e2ee-cover { background: rgba(0,0,0,.82); pointer-events: auto; }
.e2ee-window {
    display: flex;
    background: #0b0b0b;
    border: 1px solid #262626;
    flex-direction: column;
    border-radius: 12px;
    pointer-events: auto;
    position: relative;
    z-index: 10000;
    box-shadow: 0 24px 64px rgba(0,0,0,.6);
    max-width: calc(100vw - 32px);
    overflow: hidden;
}
.e2ee-ui .e2ee-window > * { margin-left: 20px; margin-right: 20px; }
.e2ee-ui .e2ee-text { display: block; color: #bdbdbd; font-size: 14px; line-height: 1.45; }
.e2ee-ui .e2ee-text * { display: inline; font-size: 14px; }
.e2ee-ui .e2ee-text b { color: #fff; font-weight: 700; }
.e2ee-ui .e2ee-titlebar {
    margin: 0;
    padding: 18px 56px 16px 20px;
    align-items: center;
    gap: 12px;
    border-bottom: 1px solid #1d1d1d;
}
.e2ee-ui .e2ee-titletext { flex-direction: column; gap: 3px; }
.e2ee-ui img.e2ee-logo { border-radius: 6px; flex: 0 0 auto; }
.e2ee-ui h4 { font-weight: 700; font-size: 16px; letter-spacing: .2px; }
.e2ee-ui .e2ee-sub { color: #8a8a8a; font-size: 12px; }
.e2ee-ui .e2ee-footer {
    margin: 0;
    padding: 14px 20px;
    background: #050505;
    border-top: 1px solid #1d1d1d;
    justify-content: flex-end;
    align-items: center;
    gap: 8px;
}
.e2ee-ui .e2ee-credit { margin-right: auto; color: #5f5f5f; font-size: 12px; font-weight: 600; letter-spacing: .3px; }
.e2ee-ui h5, .e2ee-ui h5 * {
    color: #9a9a9a;
    text-transform: uppercase;
    letter-spacing: .6px;
    font-weight: 700;
    font-size: 12px;
}
.e2ee-ui .e2ee-error { color: #ff4d4d; font-size: 13px; margin-top: 8px; }
.e2ee-ui input[type=password], .e2ee-ui input[type=text] {
    background: #000;
    border: 1px solid #2a2a2a;
    border-radius: 8px;
    height: 40px;
    padding: 0 12px;
    outline: 0;
    user-select: text;
    transition: border-color .15s ease;
}
.e2ee-ui input:focus { border-color: ${BaseColor}; }
.e2ee-ui .e2ee-pass { position: relative; align-items: center; }
.e2ee-ui .e2ee-pass input {
    width: 100%;
    height: 44px;
    padding-right: 72px;
    font-family: system-ui, "Segoe UI", Roboto, Arial, sans-serif;
    font-size: 17px;
    letter-spacing: .5px;
    color: #fff;
    -webkit-text-fill-color: #fff;
    caret-color: ${BaseColor};
}
.e2ee-ui .e2ee-pass input[type=password] { font-size: 22px; letter-spacing: 3px; }
.e2ee-ui .e2ee-showpass {
    position: absolute;
    right: 6px;
    min-height: 30px;
    height: 30px;
    padding: 0 10px;
    border: 1px solid #333;
    border-radius: 6px;
    background: #111;
    color: #cfcfcf;
    font-size: 12px;
    font-weight: 600;
}
.e2ee-ui .e2ee-showpass:hover { color: #fff; border-color: #666; }

/* decrypted video player */
.e2ee-video-overlay {
    position: absolute;
    inset: 0;
    z-index: 2;
    display: flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
    background: rgba(0,0,0,.18);
}
.e2ee-video-overlay:hover { background: rgba(0,0,0,.05); }
.e2ee-video-overlay .e2ee-play {
    width: 56px;
    height: 56px;
    border-radius: 50%;
    background: ${BaseColor};
    display: flex;
    align-items: center;
    justify-content: center;
    box-shadow: 0 4px 18px rgba(0,0,0,.5);
    transition: transform .12s ease;
}
.e2ee-video-overlay:hover .e2ee-play { transform: scale(1.08); }
.e2ee-video-overlay .e2ee-play svg { width: 26px; height: 26px; margin-left: 3px; fill: #fff; }
.e2ee-video-overlay .e2ee-video-name {
    position: absolute;
    left: 8px;
    bottom: 8px;
    max-width: calc(100% - 16px);
    padding: 2px 7px;
    border-radius: 4px;
    background: rgba(0,0,0,.65);
    color: #fff;
    font: 600 12px var(--font-primary, sans-serif);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
}
.e2ee-video {
    position: absolute;
    inset: 0;
    z-index: 3;
    width: 100%;
    height: 100%;
    background: #000;
    object-fit: contain;
}
.e2ee-ui button {
    min-height: 36px;
    border-radius: 8px;
    justify-content: center;
    align-items: center;
    padding: 0 16px;
    cursor: pointer;
    font-size: 14px;
    font-weight: 600;
}
.e2ee-ui .e2ee-btn { border: 0; background: ${BaseColor}; transition: background-color .15s ease; }
.e2ee-ui .e2ee-btn:hover { background: ${BaseColorHover}; }
.e2ee-ui .e2ee-lnkbtn { border: 0; background: transparent; color: #cfcfcf; }
.e2ee-ui .e2ee-lnkbtn:hover { color: #fff; text-decoration: underline; }
.e2ee-ui .e2ee-rbtn { border: 1px solid rgba(255,0,0,.45); background: transparent; color: #ff4d4d; transition: background-color .15s ease; }
.e2ee-ui .e2ee-rbtn:hover { background: rgba(255,0,0,.12); }
.e2ee-ui .e2ee-wbtn { border: 1px solid #3a3a3a; background: transparent; transition: border-color .15s ease; }
.e2ee-ui .e2ee-wbtn:hover { border-color: #8a8a8a; }
.e2ee-ui .e2ee-rbtn:disabled, .e2ee-ui .e2ee-wbtn:disabled { color: #6a6a6a; border-color: #2a2a2a; background: transparent; cursor: default; }
.e2ee-ui .e2ee-close {
    position: absolute;
    right: 14px;
    top: 16px;
    width: 28px;
    height: 28px;
    margin: 0;
    border-radius: 6px;
    cursor: pointer;
    align-items: center;
    justify-content: center;
    color: #8a8a8a;
    font-size: 20px;
    line-height: 1;
}
.e2ee-ui .e2ee-close:hover { color: #fff; background: #1d1d1d; }
.e2ee-ui .e2ee-scroll {
    display: block;
    overflow-x: hidden;
    overflow-y: auto;
    margin: 0;
    padding: 4px 12px 4px 20px;
}
.e2ee-ui .e2ee-scroll::-webkit-scrollbar { width: 8px; }
.e2ee-ui .e2ee-scroll::-webkit-scrollbar-thumb { background: #2a2a2a; border-radius: 4px; }
.e2ee-ui .e2ee-list { flex-direction: column; min-height: 100px; }
.e2ee-ui .e2ee-list > div {
    border: 1px solid #1f1f1f;
    background: #0f0f0f;
    border-radius: 8px;
    margin: 4px 0;
}
.e2ee-ui .e2ee-list > div:hover { border-color: #333; }
.e2ee-ui .e2ee-list > div > div:first-child {
    margin-right: auto;
    padding: 12px 0 10px 16px;
    flex-direction: column;
    gap: 4px;
    min-width: 0;
}
.e2ee-ui .e2ee-list h6 {
    font-weight: 600;
    line-height: 20px;
    word-break: break-word;
    max-width: 400px;
    align-items: center;
    gap: 6px;
}
.e2ee-ui .e2ee-list p { font-size: 12px; color: #8a8a8a; }
.e2ee-ui .e2ee-list > h5 { padding: 8px 0 4px; }
.e2ee-ui .e2ee-list > h5 > p { font-size: 11px; justify-content: center; }
.e2ee-ui .e2ee-edit { cursor: pointer; opacity: .55; font-size: 13px; }
.e2ee-ui .e2ee-edit:hover { opacity: 1; }
.e2ee-ui .e2ee-listbox { width: 84px; align-items: center; justify-content: center; }
.e2ee-ui .e2ee-listcheckbox > label { height: 22px; cursor: pointer; }
.e2ee-ui .e2ee-listcheckbox input + *::after {
    content: '';
    width: 22px;
    height: 22px;
    border: 1px solid #444;
    border-radius: 5px;
    transition: background .15s ease, border-color .15s ease;
}
.e2ee-ui .e2ee-listcheckbox input:checked + *::after {
    content: url('data:image/svg+xml,%3Csvg stroke="%23FFF" viewBox="0 0 18 18" xmlns="http://www.w3.org/2000/svg"%3E%3Cpolyline stroke-width="2" fill="none" points="3.5 9.5 7 13 15 5"%3E%3C/polyline%3E%3C/svg%3E');
    border-color: ${BaseColor};
    background: ${BaseColor};
    padding: 2px;
}
.e2ee-ui .e2ee-listcheckbox input:disabled + *::after { opacity: .3; }
.e2ee-ui .e2ee-hidden {
    width: 0;
    height: 0;
    padding: 0;
    border: 0;
    overflow: hidden;
    outline: 0;
    margin: 0;
    opacity: 0;
    position: absolute;
}
.e2ee-ui .e2ee-trusted { color: ${BaseColor}; }

/* popups */
.e2ee-popups {
    position: fixed;
    right: 24px;
    bottom: 84px;
    z-index: 10002;
    display: flex;
    flex-direction: column;
    gap: 10px;
    pointer-events: none;
}
.e2ee-ui.e2ee-popup { pointer-events: auto; width: 320px; }
.e2ee-ui.e2ee-popup .e2ee-popup-body { margin: 16px 18px; gap: 10px; align-items: flex-start; word-break: break-word; }
.e2ee-ui.e2ee-popup .e2ee-popup-body p { line-height: 1.35; }
.e2ee-ui.e2ee-popup .e2ee-footer { padding: 10px 12px; }

/* context menu */
.e2ee-menu {
    position: fixed;
    z-index: 10005;
    min-width: 230px;
    max-width: 320px;
    max-height: 75vh;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    background: #0b0b0b;
    border: 1px solid #262626;
    border-radius: 10px;
    padding: 6px;
    box-shadow: 0 12px 32px rgba(0,0,0,.55);
    font-family: var(--font-primary, "gg sans", "Noto Sans", sans-serif);
    user-select: none;
}
.e2ee-menu-head { display: flex; align-items: center; gap: 10px; padding: 6px 8px 10px; margin-bottom: 4px; border-bottom: 1px solid #1d1d1d; cursor: pointer; }
.e2ee-menu-head img { border-radius: 6px; }
.e2ee-menu-head b { display: block; color: #fff; font-size: 14px; font-weight: 700; }
.e2ee-menu-head small { display: block; color: #7a7a7a; font-size: 11px; font-weight: 600; margin-top: 2px; }
.e2ee-menu-label { padding: 8px 8px 3px; color: #6f6f6f; font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: .6px; }
.e2ee-menu-sep { height: 1px; background: #1d1d1d; margin: 5px 2px; }
.e2ee-menu-item {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 10px;
    border-radius: 6px;
    color: #dcdcdc;
    font-size: 14px;
    font-weight: 500;
    cursor: pointer;
}
.e2ee-menu-item span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.e2ee-menu-item svg { width: 16px; height: 16px; flex: 0 0 auto; }
.e2ee-menu-item:hover { background: ${BaseColor}; color: #fff; }
.e2ee-menu-item.e2ee-selected::after { content: '✓'; margin-left: auto; padding-left: 8px; }
.e2ee-menu-item.e2ee-trusted span { color: ${BaseColor}; }
.e2ee-menu-item.e2ee-trusted:hover span { color: #fff; }
.e2ee-menu-item.e2ee-danger { color: #ff4d4d; }
.e2ee-menu-item.e2ee-danger:hover { color: #fff; }
.e2ee-menu-item.e2ee-disabled { opacity: .4; pointer-events: none; }

/* chat bar lock button */
.e2ee-chatbtn {
    display: flex;
    align-items: center;
    justify-content: center;
    flex: 0 0 auto;
    align-self: center;
    width: 32px;
    height: 32px;
    margin: 0 2px;
    border-radius: 6px;
    cursor: pointer;
    color: var(--interactive-icon-default, var(--interactive-normal, #b5bac1));
    transition: color .12s ease, background-color .12s ease;
}
.e2ee-chatbtn:hover { color: var(--interactive-icon-hover, var(--interactive-hover, #fff)); background: rgba(127,127,127,.12); }
.e2ee-chatbtn.e2ee-on, .e2ee-chatbtn.e2ee-on:hover { color: ${BaseColor}; }
.e2ee-chatbtn.e2ee-disabled { opacity: .35; cursor: not-allowed; }
.e2ee-chatbtn svg { width: 22px; height: 22px; display: block; }
.e2ee-chatbtn.e2ee-floating {
    position: fixed;
    right: 24px;
    bottom: 96px;
    z-index: 9999;
    width: 46px;
    height: 46px;
    border-radius: 50%;
    background: #000;
    border: 1px solid #333;
    box-shadow: 0 6px 20px rgba(0,0,0,.45);
}

/* header key chip */
.e2ee-chip {
    display: flex;
    align-items: center;
    gap: 6px;
    flex: 0 1 auto;
    align-self: center;
    height: 24px;
    max-width: 200px;
    margin: 0 8px;
    padding: 0 10px;
    border-radius: 12px;
    border: 1px solid var(--background-modifier-accent, rgba(127,127,127,.35));
    color: var(--text-muted, #949ba4);
    font-family: var(--font-primary, "gg sans", "Noto Sans", sans-serif);
    font-size: 12px;
    font-weight: 600;
    white-space: nowrap;
    cursor: pointer;
    user-select: none;
}
.e2ee-chip span { overflow: hidden; text-overflow: ellipsis; }
.e2ee-chip svg { width: 14px; height: 14px; flex: 0 0 auto; }
.e2ee-chip:hover { color: var(--interactive-hover, #fff); border-color: rgba(255,0,0,.6); }
.e2ee-chip.e2ee-on { color: #fff; background: rgba(255,0,0,.14); border-color: rgba(255,0,0,.55); }
.e2ee-chip.e2ee-on svg { color: ${BaseColor}; }
.e2ee-chip.e2ee-trusted span { color: ${BaseColor}; }
.theme-light .e2ee-chip.e2ee-on { color: #000; }
`,
    Inject: function () {
      if (this.domElement != null && this.domElement.isConnected) return;
      let style = document.createElement('style');
      style.id = 'e2ee-discord-style';
      style.textContent = this.css;
      (document.head || document.documentElement).appendChild(style);
      this.domElement = style;
    },
    Remove: function () {
      Utils.CloseDialog(this.domElement);
    },
  };

  /* ──────────────────────────────── Windows ──────────────────────────────── */

  const UnlockWindow = {
    html: `<div class="e2ee-ui">
<div class="E2EE_CANCEL e2ee-cover"></div>
<div class="e2ee-overlay">
    <form class="E2EE_UNBLOCK e2ee-window" style="width:460px">
        ${TitleBar('Unlock Database', 'Your encryption keys are protected by a password')}
        <h5 style="margin-top:18px">Password</h5>
        ${PasswordField('current-password', 0)}
        <p class="E2EE_ERROR e2ee-error" style="display:none">Wrong password</p>
        <div style="height:20px"></div>
        <div class="e2ee-footer"><p class="e2ee-credit">${AppCredit}</p><button type="button" class="E2EE_CANCEL e2ee-lnkbtn">Cancel</button><button type="button" class="E2EE_NEWDB e2ee-rbtn">New DB</button><button type="submit" class="e2ee-btn" style="min-width:96px">Unlock</button></div>
    </form>
</div>
</div>`,
    Show: function (passwordCallback, newdbCallback, cancelCallback, wrongPassword) {
      this.Remove();
      let wrapper = document.createElement('div');
      wrapper.innerHTML = this.html;
      if (wrongPassword)
        wrapper.getElementsByClassName('E2EE_ERROR')[0].style.display = '';

      Utils.AttachEventToClass(wrapper, 'E2EE_UNBLOCK', 'submit', (e) => {
        e.preventDefault();
        this.Remove();
        passwordCallback(wrapper.getElementsByClassName('E2EE_PASSWORD')[0].value);
      });
      Utils.AttachEventToClass(wrapper, 'E2EE_NEWDB', 'click', () => {
        this.Remove();
        newdbCallback();
      });
      Utils.AttachEventToClass(wrapper, 'E2EE_CANCEL', 'click', () => {
        this.Remove();
        if (cancelCallback) cancelCallback();
      });

      document.body.appendChild(wrapper);
      this.domElement = wrapper;
      Utils.SetupDialog(wrapper);
    },
    Remove: function () {
      Utils.CloseDialog(this.domElement);
    },
  };
  const NewdbWindow = {
    html: `<div class="e2ee-ui">
<div class="E2EE_CANCEL e2ee-cover"></div>
<div class="e2ee-overlay">
    <form class="E2EE_CREATEDB e2ee-window" style="width:520px">
        ${TitleBar(`Welcome to ${AppName}`, 'Create a database to store your encryption keys')}
        <p class="e2ee-text" style="margin-top:16px">Already use ${AppName} (or SimpleDiscordCrypt) somewhere else? Import that database instead — choose <b>Secondary</b> if this is an extra device for the same account.</p>
        <h5 style="margin-top:18px">Password <span style="margin-left:6px;opacity:.6">(optional)</span></h5>
        ${PasswordField('new-password', 20)}
        <div class="e2ee-footer"><p class="e2ee-credit">${AppCredit}</p><button type="button" class="E2EE_CANCEL e2ee-lnkbtn">Cancel</button><button type="button" class="E2EE_IMPORT e2ee-wbtn">Import</button><button type="button" class="E2EE_SECONDARY e2ee-wbtn">Secondary</button><button type="submit" class="e2ee-btn" style="min-width:96px">Create</button></div>
    </form>
</div>
</div>`,
    Show: function (newdbCallback, importCallback, secondaryCallback, cancelCallback) {
      this.Remove();
      let wrapper = document.createElement('div');
      wrapper.innerHTML = this.html;

      Utils.AttachEventToClass(wrapper, 'E2EE_CREATEDB', 'submit', (e) => {
        e.preventDefault();
        this.Remove();
        newdbCallback(wrapper.getElementsByClassName('E2EE_PASSWORD')[0].value);
      });
      Utils.AttachEventToClass(wrapper, 'E2EE_IMPORT', 'click', () => importCallback());
      Utils.AttachEventToClass(wrapper, 'E2EE_SECONDARY', 'click', () => secondaryCallback());
      Utils.AttachEventToClass(wrapper, 'E2EE_CANCEL', 'click', () => {
        this.Remove();
        if (cancelCallback) cancelCallback();
      });

      document.body.appendChild(wrapper);
      this.domElement = wrapper;
      Utils.SetupDialog(wrapper);
    },
    Remove: function () {
      Utils.CloseDialog(this.domElement);
    },
  };
  const NewPasswordWindow = {
    html: `<div class="e2ee-ui">
<div class="E2EE_CANCEL e2ee-cover"></div>
<div class="e2ee-overlay">
    <form class="E2EE_CHANGEPASSWORD e2ee-window" style="width:460px">
        ${TitleBar('Change Database Password', 'Leave empty to remove the password')}
        <h5 style="margin-top:18px">New password <span style="margin-left:6px;opacity:.6">(optional)</span></h5>
        ${PasswordField('new-password', 20)}
        <div class="e2ee-footer"><p class="e2ee-credit">${AppCredit}</p><button type="button" class="E2EE_CANCEL e2ee-lnkbtn">Cancel</button><button type="submit" class="e2ee-btn" style="min-width:96px">Change</button></div>
    </form>
</div>
</div>`,
    Show: function (newPasswordCallback, cancelCallback) {
      this.Remove();
      let wrapper = document.createElement('div');
      wrapper.innerHTML = this.html;

      Utils.AttachEventToClass(wrapper, 'E2EE_CHANGEPASSWORD', 'submit', (e) => {
        e.preventDefault();
        this.Remove();
        newPasswordCallback(wrapper.getElementsByClassName('E2EE_PASSWORD')[0].value);
      });
      Utils.AttachEventToClass(wrapper, 'E2EE_CANCEL', 'click', () => {
        this.Remove();
        if (cancelCallback) cancelCallback();
      });

      document.body.appendChild(wrapper);
      this.domElement = wrapper;
      Utils.SetupDialog(wrapper);
    },
    Remove: function () {
      Utils.CloseDialog(this.domElement);
    },
  };

  const ListWindowHtml = (title, subtitle, header) => `<div class="e2ee-ui">
<div class="E2EE_CLOSE e2ee-cover"></div>
<div class="e2ee-overlay">
    <div class="e2ee-window" style="width:600px">
        ${TitleBar(title, subtitle)}
        <a class="E2EE_CLOSE e2ee-close" title="Close">×</a>
        <div class="e2ee-scroll" style="max-height:60vh">
        <div class="E2EE_LIST e2ee-list">
            <h5>${header}</h5>
        </div>
        </div>
        <div class="e2ee-footer">
            <p class="e2ee-credit">${AppCredit}</p>
            <button type="button" class="E2EE_CLOSE e2ee-btn" style="min-width:96px">Done</button>
        </div>
    </div>
</div>
</div>`;

  const KeyManagerWindow = {
    html: ListWindowHtml(
      'Key Manager',
      'Rename, hide or delete your encryption keys',
      `<p>Key</p><p style="margin-left:auto;width:84px">Hidden</p><p style="width:84px">Delete</p>`
    ),
    Show: function (keys, setKeyDescriptor, setKeyHidden, deleteKey) {
      this.Remove();
      let wrapper = document.createElement('div');
      wrapper.innerHTML = this.html;

      Utils.AttachEventToClass(wrapper, 'E2EE_CLOSE', 'click', () => this.Remove());

      let list = wrapper.getElementsByClassName('E2EE_LIST')[0];
      for (let key of keys) {
        let listItem = document.createElement('div');
        const descriptorHtml = () =>
          `${HtmlEscape(key.descriptor)} <a class="E2EE_EDITDESCRIPTOR e2ee-edit" title="Rename">✎</a>`;
        listItem.innerHTML = `<div>
                    <h6 class="E2EE_DESCRIPTOR${key.trusted ? ' e2ee-trusted' : ''}">${descriptorHtml()}</h6>
                    <p>${HtmlEscape(key.type)} · last used ${Utils.FormatTime(key.lastseen)}</p>
                </div>
                <div class="e2ee-listbox e2ee-listcheckbox"><label><input type="checkbox" class="E2EE_SETHIDDEN" style="display:none"${
                  key.hidden ? ' checked' : ''
                }${key.type !== 'GROUP' ? ' disabled' : ''}><p></p></label></div>
                <div class="e2ee-listbox"><button type="button" class="E2EE_DELETE e2ee-rbtn" style="padding:0 12px"${
                  key.protected ? ' disabled' : ''
                }>Delete</button></div>`;
        const editDescriptor = () => {
          let descriptorElement = listItem.getElementsByClassName('E2EE_DESCRIPTOR')[0];
          descriptorElement.innerHTML = `<input type="text" class="E2EE_DESCRIPTORINPUT" style="width:340px">`;
          const changeBack = () => {
            descriptorElement.innerHTML = descriptorHtml();
            Utils.AttachEventToClass(descriptorElement, 'E2EE_EDITDESCRIPTOR', 'click', editDescriptor);
          };
          let descriptorInput = descriptorElement.getElementsByClassName('E2EE_DESCRIPTORINPUT')[0];
          descriptorInput.value = key.rawDescriptor;
          descriptorInput.onkeydown = function (e) {
            if (e.key === 'Enter') {
              e.preventDefault();
              setKeyDescriptor(key, this.value);
              changeBack();
            } else if (e.key === 'Escape') changeBack();
          };
          descriptorInput.focus();
        };
        Utils.AttachEventToClass(listItem, 'E2EE_EDITDESCRIPTOR', 'click', editDescriptor);
        Utils.AttachEventToClass(listItem, 'E2EE_SETHIDDEN', 'change', function () {
          setKeyHidden(key, this.checked);
        });
        Utils.AttachEventToClass(listItem, 'E2EE_DELETE', 'click', async () => {
          if (
            !(await PopupManager.NewPromise(
              `Delete the key "${key.descriptor}"? Messages encrypted with it can no longer be read unless someone shares it again.`,
              true
            ))
          )
            return;
          deleteKey(key);
          listItem.remove();
        });

        list.appendChild(listItem);
      }

      document.body.appendChild(wrapper);
      this.domElement = wrapper;
      Utils.SetupDialog(wrapper);
    },
    Remove: function () {
      Utils.CloseDialog(this.domElement);
    },
  };
  const ChannelManagerWindow = {
    html: ListWindowHtml(
      'Channel Manager',
      'Per-channel encryption settings',
      `<p>Channel</p><p style="margin-left:auto;width:84px">Delete</p>`
    ),
    Show: function (channels, deleteChannel) {
      this.Remove();
      let wrapper = document.createElement('div');
      wrapper.innerHTML = this.html;

      Utils.AttachEventToClass(wrapper, 'E2EE_CLOSE', 'click', () => this.Remove());

      let list = wrapper.getElementsByClassName('E2EE_LIST')[0];
      for (let channel of channels) {
        let listItem = document.createElement('div');
        listItem.innerHTML = `<div>
                    <h6>${HtmlEscape(channel.descriptor)}</h6>
                    <p>${channel.encrypted ? 'Encrypted · ' : ''}last seen ${Utils.FormatTime(channel.lastseen)}</p>
                </div>
                <div class="e2ee-listbox"><button type="button" class="E2EE_DELETE e2ee-rbtn" style="padding:0 12px">Delete</button></div>`;
        Utils.AttachEventToClass(listItem, 'E2EE_DELETE', 'click', () => {
          deleteChannel(channel);
          listItem.remove();
        });

        list.appendChild(listItem);
      }

      document.body.appendChild(wrapper);
      this.domElement = wrapper;
      Utils.SetupDialog(wrapper);
    },
    Remove: function () {
      Utils.CloseDialog(this.domElement);
    },
  };
  const ShareKeyWindow = {
    html: ListWindowHtml(
      'Share Keys',
      'Send keys to this person over your secured DM',
      `<p>Key</p><p style="margin-left:auto;width:84px">Share</p>`
    ),
    Show: function (keys, shareKey) {
      this.Remove();
      let wrapper = document.createElement('div');
      wrapper.innerHTML = this.html;

      Utils.AttachEventToClass(wrapper, 'E2EE_CLOSE', 'click', () => this.Remove());

      let list = wrapper.getElementsByClassName('E2EE_LIST')[0];
      for (let key of keys) {
        let listItem = document.createElement('div');
        listItem.innerHTML = `<div>
                    <h6>${HtmlEscape(key.descriptor)}</h6>
                    <p>last used ${Utils.FormatTime(key.lastseen)}</p>
                </div>
                <div class="e2ee-listbox"><button type="button" class="E2EE_SHARE e2ee-wbtn" style="padding:0 12px">Share</button></div>`;
        Utils.AttachEventToClass(listItem, 'E2EE_SHARE', 'click', function () {
          shareKey(key);
          this.disabled = true;
          this.textContent = 'Sent';
        });

        list.appendChild(listItem);
      }

      document.body.appendChild(wrapper);
      this.domElement = wrapper;
      Utils.SetupDialog(wrapper);
    },
    Remove: function () {
      Utils.CloseDialog(this.domElement);
    },
  };

  const PopupManager = {
    Inject: function () {
      if (this.domElement != null && this.domElement.isConnected) return;
      let wrapper = document.createElement('div');
      wrapper.className = 'e2ee-popups';
      document.body.appendChild(wrapper);
      this.domElement = wrapper;
      Utils.SetupDialog(wrapper);
    },
    Update: function () {
      if (this.domElement != null && !this.domElement.isConnected)
        document.body.appendChild(this.domElement);
    },
    New: function (message, okCallback, cancelCallback, ontop) {
      if (this.domElement == null) this.Inject();
      let popup = document.createElement('div');
      popup.className = 'e2ee-ui e2ee-window e2ee-popup';
      popup.innerHTML = `<div class="e2ee-popup-body">${LogoImg(20)}<p>${HtmlEscape(message)}</p></div>
    <div class="e2ee-footer">
        <p class="e2ee-credit">${AppName}</p>
        <button type="button" class="E2EE_CANCEL e2ee-lnkbtn">Cancel</button>
        <button type="button" class="E2EE_OK e2ee-btn" style="min-width:80px">OK</button>
    </div>`;
      Utils.AttachEventToClass(popup, 'E2EE_OK', 'click', () => {
        popup.remove();
        okCallback();
      });
      Utils.AttachEventToClass(popup, 'E2EE_CANCEL', 'click', () => {
        popup.remove();
        if (cancelCallback) cancelCallback();
      });
      if (ontop) this.domElement.appendChild(popup);
      else this.domElement.prepend(popup);
      return popup;
    },
    // Information only: a single OK button, dismissed automatically
    Notice: function (message, timeout = 12000) {
      if (this.domElement == null) this.Inject();
      let popup = document.createElement('div');
      popup.className = 'e2ee-ui e2ee-window e2ee-popup';
      popup.innerHTML = `<div class="e2ee-popup-body">${LogoImg(20)}<p>${HtmlEscape(message)}</p></div>
    <div class="e2ee-footer">
        <p class="e2ee-credit">${AppName}</p>
        <button type="button" class="E2EE_OK e2ee-btn" style="min-width:80px">OK</button>
    </div>`;
      const close = () => popup.remove();
      Utils.AttachEventToClass(popup, 'E2EE_OK', 'click', close);
      if (timeout > 0) setTimeout(close, timeout);
      this.domElement.appendChild(popup);
      return popup;
    },
    NewPromise: function (message, ontop, timeout) {
      return new Promise((resolve) => {
        if (timeout > 0) {
          let cancelTimeout;
          let popup = this.New(
            message,
            () => {
              clearTimeout(cancelTimeout);
              resolve(true);
            },
            () => {
              clearTimeout(cancelTimeout);
              resolve(false);
            },
            ontop
          );

          cancelTimeout = setTimeout(() => {
            popup.remove();
            resolve(false);
          }, timeout);
        } else {
          let popup = this.New(
            message,
            () => resolve(true),
            () => resolve(false),
            ontop
          );
          if (typeof timeout === 'object' && timeout != null) {
            timeout.cancel = () => {
              popup.remove();
              resolve(false);
            };
          }
        }
      });
    },
    Remove: function () {
      Utils.CloseDialog(this.domElement);
      this.domElement = null;
    },
  };

  const KeyVisualizerWindow = {
    // EmojiHash v1.1 by An0 — must stay identical so both sides draw the same picture
    EmojiHash: function (canvas, hashBuffer) {
      var ctx;

      function drawEmoji(emoji, x, y, size, rotation) {
        ctx.save();
        ctx.translate(x, y);
        if (rotation) ctx.rotate((rotation * Math.PI) / 180);
        ctx.scale(size, size);
        ctx.fillText(emoji, 0, 0);
        ctx.restore();
      }
      function drawRectangle(color, x, y, width, height, rotation) {
        ctx.save();
        ctx.translate(x, y);
        if (rotation) ctx.rotate((rotation * Math.PI) / 180);
        ctx.fillStyle = color;
        ctx.fillRect(-width / 2, -height / 2, width, height);
        ctx.restore();
      }
      var uintOffset = 0;
      var inUintOffset = 0;
      var uints = new DataView(hashBuffer);
      function popBits(count) {
        //max 32
        let bits;
        let newInUintOffset = inUintOffset + count;
        if (newInUintOffset > 31) {
          bits = uints.getUint32(uintOffset) & ~(~0 << (32 - inUintOffset));
          inUintOffset = newInUintOffset - 32;
          uintOffset += 4;
          if (uintOffset === hashBuffer.byteLength) uintOffset = 0;
          if (inUintOffset !== 0) {
            bits =
              (bits << inUintOffset) |
              (uints.getUint32(uintOffset) >>> (32 - inUintOffset));
          }
        } else {
          bits =
            (uints.getUint32(uintOffset) >>> (32 - newInUintOffset)) &
            ~(~0 << count);
          inUintOffset = newInUintOffset;
        }

        return bits;
      }

      ctx = canvas.getContext('2d');
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.font = '1px sans-serif';
      ctx.translate(canvas.width / 2, canvas.height / 2);
      let scale = (Math.min(canvas.width / 4, canvas.height / 3) / 100) * 4;
      ctx.scale(scale, scale);

      function drawSky() {
        let color;
        switch (popBits(3)) {
          case 0: //purple
            color = '#a254d3';
            break;
          case 1: //rose
            color = '#f6c4df';
            break;
          case 2: //blue
            color = '#2b7cb3';
            break;
          case 3: //darkblue
            color = '#154167';
            break;
          default: //lightblue
            color = '#9bcfea';
        }

        drawRectangle(color, 0, 0, 1000, 1000);
      }

      const airObjects =
        '☀️|🌑|☁️|🌩️|🌨️|🐉|🦇|🦅|🕊️|🐝|🦋|🍃|🚁|✈️|🛩️|🚀|🛸|🛰️|🌜|☄️|🌟|❄️|⚡|✨|🎈|👾|👻'.split('|');
      function drawAirObject(x, y, size, rotation) {
        if (popBits(1)) return;

        drawEmoji(airObjects[popBits(5) % 27], x, y, size, rotation); //32-27 first 5 have double probability
      }
      const handEmojis =
        '👌|🖕|✌|👊|👍|👎|👋|👈|👉|☝|👆|👇|🤞|🖖|🤟|🤙|🖐|✋|✍|💰|💀|💩|💣|🥊|🎨|🎺|📷|🎥|🔦|💼|🔎|📕|✉️|✏️|📏|🔫|🔨|🔧|💉|🚬|🗝️|📞|🎮|🎓|🍆'.split('|');
      function drawHandEmoji(x, y, size, rotation) {
        drawEmoji(handEmojis[popBits(6) % 45], x, y, size, rotation);
      }
      const bodyEmojis = '👔|👕|🥋|🎽|🧥|👗|👘|👙|👚'.split('|');
      const headEmojis =
        '🤔|😂|😤|😭|😋|🤗|😏|😳|😆|🤨|😎|🙄|😑|😍|😘|🙂|🤩|😶|😣|😮|🤐|😫|😴|😜|🤤|😒|🙃|🤑|☹️|😁|😖|😱|🤯|😬|🤪|😵|😡|🤒|🤢|🤮|🤧|😇|🤠|🤡|🤥|🤣|🤫|🧐|🤓|😈|💩|🤖|👽|💀|👺|👶|👩|👨|👴|👵|🤴|👳|👲|🧔|👱|🎅|🐵|🐶|🐺|🦊|🐱|🦁|🐯|🐴|🦄|🦓|🐮|🐷|🐗|🐭|🐹|🐰|🐻|🐸|🐲|🐔|🎃'.split('|');
      function drawPerson(x, y, size) {
        ctx.save();
        ctx.translate(x, y);
        let scale = size / 100;
        ctx.scale(scale, scale);

        drawRectangle('#000', 0, -10, 4, 50); //body
        drawRectangle('#000', -9, 26, 4, 30, 35); //legs
        drawRectangle('#000', 9, 26, 4, 30, -35);

        switch (
          popBits(2) //left arm
        ) {
          case 0: //up
            drawRectangle('#000', -12, -23, 4, 30, -55);
            drawHandEmoji(-26, -34, 15);
            break;
          case 1: //middle
            drawRectangle('#000', -15, -15, 30, 4);
            drawHandEmoji(-30, -18, 15);
            break;
          default: //down
            drawRectangle('#000', -12, -8, 4, 30, 55);
            drawHandEmoji(-26, -4, 15);
        }
        switch (
          popBits(2) //right arm
        ) {
          case 0: //up
            drawRectangle('#000', 12, -23, 4, 30, 55);
            drawHandEmoji(26, -34, 15);
            break;
          case 1: //middle
            drawRectangle('#000', 15, -15, 30, 4);
            drawHandEmoji(30, -18, 15);
            break;
          default: //down
            drawRectangle('#000', 12, -8, 4, 30, -55);
            drawHandEmoji(26, -4, 15);
        }

        drawEmoji(bodyEmojis[popBits(4) % 9], 0, -5, 28); //chest
        drawEmoji(headEmojis[popBits(12) % 87], 0, -35, 25); //face 4096 % 87 = first 7 have increased chance

        if (popBits(1)) drawEmoji('👟', -13, 35, 15); //left foot
        if (popBits(1)) drawEmoji('👟', 19, 35, 15); //right foot

        ctx.restore();
      }
      const tableObjects =
        '🍞|👓|🛍️|💎|🍎|🍇|🍉|🍊|🍋|🍌|🍏|🍐|🍑|🍒|🍓|🥝|🍅|🥥|🥔|🥕|🌽|🌶️|🥒|🥦|🍄|🥜|🥐|🥨|🥞|🧀|🍖|🍗|🥩|🥓|🍔|🍟|🍕|🌭|🥪|🌮|🥚|🍲|🥣|🥗|🍿|🥫|🍱|🍙|🍣|🥡|🍦|🍩|🎂|🥧|🍫|🍮|🍯|🍼|☕|🍷|🍸|🍺|🔪|🏺|🛎️|⏰|⌛|🌂|🎁|🏆|⚽|🎳|🔮|🕹️|🎲|📢|📻|🎧|🎤|☎️|💻|🖨️|📺|🕯️|📦|🔭|⚗️|🔬|⚖️|🥤|📚'.split('|');
      function drawTableObject(x, y, size, rotation) {
        if (popBits(1)) return;

        drawEmoji(tableObjects[popBits(12) % 91], x, y, size, rotation);
      }
      function drawTable(x, y, size, rotation) {
        ctx.save();
        ctx.translate(x, y);
        let scale = size / 100;
        ctx.scale(scale, scale);

        drawRectangle('#999', 0, 33, 4, 34);
        drawRectangle('#f00', 0, 14, 70, 4);

        drawTableObject(-25, 2, 20);
        drawTableObject(-3, 2, 20);
        drawTableObject(25, 2, 20);

        ctx.restore();
      }
      const groundObjects =
        '🐉|💩|👯|👫|🚶🏻|🏃🏻|💃🏻|🕺🏻|🧘🏻|🕴🏻|🤺|🏇🏻|🏌🏻|⛹🏻|🏋🏻|🚴🏻|🤸🏻|🤼|🤾🏻|🐒|🦍|🐕|🐩|🐈|🐅|🐆|🐎|🦌|🐂|🐄|🐖|🐑|🐐|🐪|🐘|🦏|🐁|🐀|🐇|🐿️|🦔|🦃|🐓|🐧|🐤|🐦|🦆|🦉|🐊|🐢|🦎|🐍|🦕|🦖|🐌|🐛|🐜|🌹|🥀|🌻|🌼|🌷|🌱|🌲|🌳|🌴|🌵|🌾|🍀|⛩️|⛲|🎪|🛢️|🛵|🚲|🛴|🎏|🥅|🗑️|🗿|🏳️‍🌈|🚩|🏁|🏴|🏳️'.split('|');
      function drawGroundObject(x, y, size, rotation) {
        switch (popBits(2)) {
          case 0:
            drawPerson(x, y, size, rotation);
            break;
          case 1:
            drawTable(x, y, size, rotation);
            break;
          case 2:
            drawEmoji(groundObjects[popBits(8) % 85], x, y, size / 2, rotation);
            break;
        }
      }

      switch (popBits(2)) {
        case 0:
          {
            //park
            drawSky();
            drawRectangle('#5ce64e', 0, 50, 200, 100, 1);
            drawAirObject(-40, -27, 8);
            drawAirObject(-16, -30, 10);
            drawAirObject(17, -28, 9);
            drawAirObject(41, -20, 10);
            drawGroundObject(-37, 20, 30);
            drawGroundObject(-10, 10, 23);
            drawGroundObject(10, 0, 20);
            drawGroundObject(15, 25, 20);
            drawGroundObject(35, 20, 26);
          }
          break;
        case 1:
          {
            //beach
            drawSky();
            drawRectangle('#e5e886', 0, 50, 200, 100);
            drawRectangle('#3cc', 0, 0, 200, 10, -0.5);
            drawAirObject(-40, -27, 8);
            drawAirObject(-16, -30, 10);
            drawAirObject(17, -28, 9);
            drawAirObject(41, -20, 10);
            drawGroundObject(-37, 20, 30);
            drawGroundObject(-10, 10, 23);
            drawGroundObject(10, 0, 20);
            drawGroundObject(15, 25, 20);
            drawGroundObject(35, 20, 26);
          }
          break;
        case 2:
          {
            //campfire
            drawSky();
            drawRectangle('#49be3d', 0, 50, 200, 100);
            drawEmoji('🔥', 0, 10, 20);
            drawRectangle('#333', 0, 20, 15, 5);
            drawAirObject(-42, -20, 8);
            drawAirObject(-25, -25, 10);
            drawAirObject(22, -28, 9);
            drawAirObject(41, -20, 10);
            drawGroundObject(-37, 20, 30);
            drawGroundObject(-13, 20, 23);
            drawGroundObject(-35, -5, 20);
            drawGroundObject(15, 25, 20);
            drawGroundObject(35, 20, 26);
          }
          break;
        case 3:
          {
            //mountainslide
            drawSky();
            drawRectangle('#eff', 0, 50, 200, 100, -30);
            drawAirObject(-42, -10, 8);
            drawAirObject(-40, -25, 10);
            drawAirObject(-15, -30, 9);
            drawAirObject(15, -30, 10);
            drawGroundObject(-37, 20, 30);
            drawGroundObject(-10, 10, 23);
            drawGroundObject(20, 0, 20);
            drawGroundObject(15, 25, 20);
            drawGroundObject(35, 20, 26);
          }
          break;
      }
    },
    html: `<div class="e2ee-ui">
<div class="E2EE_CLOSE e2ee-cover"></div>
<div class="e2ee-overlay">
    <div class="e2ee-window">
        ${TitleBar('Key Visualizer', 'Compare this picture with the other person — it should be identical')}
        <a class="E2EE_CLOSE e2ee-close" title="Close">×</a>
        <canvas class="E2EE_ART" width="600" height="450" style="margin:16px 20px;border-radius:8px;max-width:calc(100vw - 72px)"></canvas>
        <div class="e2ee-footer">
            <p class="e2ee-credit">${AppCredit}</p>
            <button type="button" class="E2EE_KEYTRUST e2ee-wbtn">Toggle Key Trusted</button>
            <button type="button" class="E2EE_CLOSE e2ee-btn" style="min-width:96px">Close</button>
        </div>
    </div>
</div>
</div>`,
    Show: function (buffer, toggleTrustedCallback) {
      this.Remove();
      let wrapper = document.createElement('div');
      wrapper.innerHTML = this.html;

      Utils.AttachEventToClass(wrapper, 'E2EE_CLOSE', 'click', () => this.Remove());
      Utils.AttachEventToClass(wrapper, 'E2EE_KEYTRUST', 'click', () => {
        this.Remove();
        toggleTrustedCallback();
      });

      let canvas = wrapper.getElementsByClassName('E2EE_ART')[0];
      this.EmojiHash(canvas, buffer);

      document.body.appendChild(wrapper);
      this.domElement = wrapper;
      Utils.SetupDialog(wrapper);
    },
    Remove: function () {
      Utils.CloseDialog(this.domElement);
    },
  };

  /* ───────────────────────── Chat bar button & menu ───────────────────────── */

  const queryFirst = (selectors) => {
    for (const selector of selectors) {
      const element = document.querySelector(selector);
      if (element != null) return element;
    }
    return null;
  };

  const MenuBar = {
    toggledOnCss: `${ChatInputSelector} { box-shadow: 0 0 0 1px ${BaseColor} !important; }`,
    Show: function (api) {
      this.api = api;

      this.toggledOnStyle = document.createElement('style');
      this.toggledOnStyle.textContent = this.toggledOnCss;

      this.button = document.createElement('div');
      this.button.className = 'e2ee-chatbtn';
      this.button.setAttribute('role', 'button');
      this.button.tabIndex = 0;
      this.button.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (api.isBlacklisted()) return;
        api.toggle();
      });
      this.button.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter' && e.key !== ' ') return;
        e.preventDefault();
        e.stopPropagation();
        if (!api.isBlacklisted()) api.toggle();
      });
      this.button.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.OpenMenu(e.clientX, e.clientY);
      });

      this.chip = document.createElement('div');
      this.chip.className = 'e2ee-chip';
      this.chip.setAttribute('role', 'button');
      this.chip.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const rect = this.chip.getBoundingClientRect();
        this.OpenMenu(rect.left, rect.bottom + 6);
      });

      this.menu = document.createElement('div');
      this.menu.className = 'e2ee-menu';
      this.menu.style.display = 'none';
      this.menu.addEventListener('contextmenu', (e) => e.preventDefault());
      document.body.appendChild(this.menu);

      this.onOutside = (e) => {
        if (!this.menu.contains(e.target)) this.CloseMenu();
      };
      this.onKey = (e) => {
        if (e.key === 'Escape') this.CloseMenu();
      };

      this.observer = new MutationObserver(() => this.SchedulePlace());
      this.observer.observe(document.body, { childList: true, subtree: true });

      this.Update();
    },
    SchedulePlace: function () {
      if (this.placeTimeout != null) return;
      this.placeTimeout = setTimeout(() => {
        this.placeTimeout = null;
        this.Place();
      }, 120);
    },
    Place: function () {
      if (this.api == null) return;
      if (this.api.getChannelId() == null) {
        this.button.remove();
        this.chip.remove();
        return;
      }

      const toolbar = queryFirst(HeaderToolbarSelectors);
      const chatButtons = queryFirst(ChatButtonsSelectors);
      if (chatButtons != null) {
        this.button.classList.remove('e2ee-floating');
        if (this.button.parentElement !== chatButtons) chatButtons.prepend(this.button);
      } else if (toolbar != null) {
        this.button.classList.remove('e2ee-floating');
        if (this.button.parentElement !== toolbar) toolbar.prepend(this.button);
      } else {
        this.button.classList.add('e2ee-floating');
        if (this.button.parentElement !== document.body) document.body.appendChild(this.button);
      }

      if (toolbar != null) {
        if (this.chip.parentElement !== toolbar) toolbar.prepend(this.chip);
      } else this.chip.remove();

      if (!this.menu.isConnected) document.body.appendChild(this.menu);
    },
    Update: function () {
      if (this.api == null) return;
      const api = this.api;
      const toggledOn = !!api.getToggleStatus();
      const blacklisted = api.isBlacklisted();
      const [keyDescriptor, trusted] = api.getCurrentKeyInfo();

      this.button.innerHTML = toggledOn ? LockClosedSvg : LockOpenSvg;
      this.button.classList.toggle('e2ee-on', toggledOn);
      this.button.classList.toggle('e2ee-disabled', blacklisted);
      const buttonLabel = blacklisted
        ? `${AppName}: encryption is disabled in this server`
        : toggledOn
        ? `${AppName}: encryption ON (${keyDescriptor}) — click to disable, right-click for menu`
        : `${AppName}: encryption OFF — click to enable, right-click for menu`;
      this.button.title = buttonLabel;
      this.button.setAttribute('aria-label', buttonLabel);

      this.chip.innerHTML = `${KeySvg}<span></span>`;
      this.chip.lastChild.textContent = keyDescriptor;
      this.chip.title = `${AppName} key for this channel: ${keyDescriptor}${trusted ? ' (trusted)' : ''}`;
      this.chip.classList.toggle('e2ee-on', toggledOn);
      this.chip.classList.toggle('e2ee-trusted', !!trusted);

      if (toggledOn) {
        if (!this.toggledOnStyle.isConnected) document.head.appendChild(this.toggledOnStyle);
      } else this.toggledOnStyle.remove();

      this.Place();
    },
    OpenMenu: function (x, y) {
      const api = this.api;
      const menu = this.menu;
      menu.textContent = '';

      const addItem = (label, action, opts = {}) => {
        const item = document.createElement('div');
        item.className = 'e2ee-menu-item';
        if (opts.selected) item.classList.add('e2ee-selected');
        if (opts.danger) item.classList.add('e2ee-danger');
        if (opts.trusted) item.classList.add('e2ee-trusted');
        if (opts.disabled) item.classList.add('e2ee-disabled');
        if (opts.icon) item.innerHTML = opts.icon;
        const span = document.createElement('span');
        span.textContent = label;
        if (opts.title) item.title = opts.title;
        item.appendChild(span);
        item.addEventListener('mousedown', (e) => e.preventDefault());
        item.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          this.CloseMenu();
          action(e);
        });
        menu.appendChild(item);
      };
      const addLabel = (text) => {
        const label = document.createElement('div');
        label.className = 'e2ee-menu-label';
        label.textContent = text;
        menu.appendChild(label);
      };
      const addSeparator = () => {
        const sep = document.createElement('div');
        sep.className = 'e2ee-menu-sep';
        menu.appendChild(sep);
      };

      const head = document.createElement('div');
      head.className = 'e2ee-menu-head';
      head.title = ProjectUrl;
      head.innerHTML = `${LogoImg(28)}<div><b>${AppName}</b><small>${AppCredit} · v${AppVersion}</small></div>`;
      head.addEventListener('click', () => {
        this.CloseMenu();
        PageWindow.open(ProjectUrl, '_blank', 'noopener');
      });
      menu.appendChild(head);

      const toggledOn = !!api.getToggleStatus();
      const blacklisted = api.isBlacklisted();
      addItem(
        blacklisted
          ? 'Encryption disabled in this server'
          : toggledOn
          ? 'Disable encryption'
          : 'Enable encryption',
        () => api.toggle(),
        { icon: toggledOn ? LockOpenSvg : LockClosedSvg, disabled: blacklisted }
      );

      addLabel('Channel key');
      for (const key of api.getKeys()) {
        addItem(key.descriptor, () => api.selectKey(key), {
          selected: key.selected,
          trusted: key.trusted,
          icon: KeySvg,
        });
      }

      addSeparator();
      if (api.getIsDmChannel()) {
        addItem('Visualize Key', () => api.keyVisualizer());
        addItem('Start Key Exchange', () => api.keyExchange());
        addItem('Share Keys', () => api.keyShare());
      } else {
        addItem('Create Group Key', () => api.groupKey());
      }

      addSeparator();
      addItem('Auto key exchange with friends', () => api.toggleAutoKeyExchange(), {
        selected: api.getAutoKeyExchange(),
        title: 'When on, key exchanges with friends happen without asking (this sends messages for you)',
      });
      addItem('Key Manager', () => api.keyManager());
      addItem('Channel Manager', () => api.channelManager());

      addSeparator();
      addItem('Export Database', (e) => (e.ctrlKey || e.shiftKey ? api.exportDbRaw() : api.exportDb()), {
        title: 'Hold Ctrl or Shift for an uncompressed JSON export',
      });
      addItem('Change Database Password', () => api.newDbKey());
      addItem('New Database', () => api.newDb(), { danger: true });

      menu.style.visibility = 'hidden';
      menu.style.display = 'flex';
      const rect = menu.getBoundingClientRect();
      const left = Math.max(8, Math.min(x, PageWindow.innerWidth - rect.width - 8));
      const top = Math.max(8, Math.min(y, PageWindow.innerHeight - rect.height - 8));
      menu.style.left = left + 'px';
      menu.style.top = top + 'px';
      menu.style.visibility = 'visible';

      document.addEventListener('mousedown', this.onOutside, true);
      document.addEventListener('keydown', this.onKey, true);
      PageWindow.addEventListener('blur', this.onOutside);
    },
    CloseMenu: function () {
      if (this.menu == null) return;
      this.menu.style.display = 'none';
      document.removeEventListener('mousedown', this.onOutside, true);
      document.removeEventListener('keydown', this.onKey, true);
      PageWindow.removeEventListener('blur', this.onOutside);
    },
    Remove: function () {
      this.CloseMenu();
      if (this.observer) this.observer.disconnect();
      clearTimeout(this.placeTimeout);
      this.placeTimeout = null;
      if (this.toggledOnStyle) this.toggledOnStyle.remove();
      if (this.button) this.button.remove();
      if (this.chip) this.chip.remove();
      if (this.menu) this.menu.remove();
      this.api = null;
    },
  };

  /* ─────────────────────────────── Storage ─────────────────────────────── */

  // The old SimpleDiscordCrypt extension kept its database in the page's localStorage,
  // which Discord removes once it has loaded — grab it while we still can.
  const EarlyLocalStorage = (() => {
    try {
      return PageWindow.localStorage || null;
    } catch (e) {
      return null;
    }
  })();
  const LoadLegacyDb = async (key) => {
    try {
      const value = await Storage.get(key);
      if (value != null) return value;
    } catch (e) {}
    try {
      const json = EarlyLocalStorage?.getItem(key);
      if (json != null) return JSON.parse(json);
    } catch (e) {}
    return null;
  };

  const Storage = (() => {
    if (host.storage != null) return host.storage;

    if (typeof GM_getValue !== 'undefined' && typeof GM_setValue !== 'undefined') {
      return {
        get: async (key) => {
          const value = await GM_getValue(key);
          if (value == null) return null;
          return typeof value === 'string' ? JSON.parse(value) : value;
        },
        set: async (key, value) => {
          await GM_setValue(key, JSON.stringify(value));
        },
      };
    }

    // Discord deletes window.localStorage once it has loaded, so grab one early or borrow an iframe's
    let localStorageRef = null;
    try {
      localStorageRef = PageWindow.localStorage || null;
    } catch (e) {}
    if (localStorageRef == null) {
      try {
        const iframe = document.createElement('iframe');
        iframe.style.display = 'none';
        (document.body || document.documentElement).appendChild(iframe);
        localStorageRef = iframe.contentWindow.localStorage;
      } catch (e) {}
    }
    if (localStorageRef != null) {
      return {
        get: async (key) => {
          const value = localStorageRef.getItem(key);
          return value == null ? null : JSON.parse(value);
        },
        set: async (key, value) => {
          localStorageRef.setItem(key, JSON.stringify(value));
        },
      };
    }

    const memory = {};
    return {
      get: async (key) => (key in memory ? JSON.parse(memory[key]) : null),
      set: async (key, value) => {
        memory[key] = JSON.stringify(value);
      },
    };
  })();

  /* ──────────────────────────────── Utils ──────────────────────────────── */

  var Discord;
  var Utils = {
    Log: (...message) => {
      console.log(`%c[${AppName}]`, `color:${BaseColor};font-weight:bold`, ...message);
    },
    Warn: (...message) => {
      console.warn(`%c[${AppName}]`, `color:${BaseColor};font-weight:bold`, ...message);
    },
    Error: (...message) => {
      console.error(`%c[${AppName}]`, `color:${BaseColor};font-weight:bold`, ...message);
    },

    // Discord can run several webpack runtimes side by side; search all of them.
    Webpack: function () {
      if (this.cachedWebpack) return this.cachedWebpack;

      const chunkGlobal = PageWindow.webpackChunkdiscord_app;
      if (
        chunkGlobal == null ||
        typeof chunkGlobal.push !== 'function' ||
        chunkGlobal.push === Array.prototype.push // runtime not installed yet
      )
        return null;

      const requires = [];
      try {
        chunkGlobal.push([
          [Symbol(AppName)],
          {},
          (req) => {
            if (req != null) requires.push(req);
          },
        ]);
      } catch (e) {
        return null;
      }
      const caches = requires.map((req) => req.c).filter((c) => c != null && typeof c === 'object');
      if (caches.length === 0) return null;

      const probeKey = `__e2ee_probe_${Math.random().toString(36).slice(2)}`;
      const scanned = new Set();
      const candidateSet = new Set();
      const candidates = [];

      const addCandidate = (value) => {
        if (value == null || (typeof value !== 'object' && typeof value !== 'function')) return;
        if (value === PageWindow || candidateSet.has(value)) return;
        try {
          if (value[probeKey] !== undefined) return; // proxies that pretend to have every property
          if (typeof Node !== 'undefined' && value instanceof Node) return;
        } catch (e) {
          return;
        }
        candidateSet.add(value);
        candidates.push(value);
      };

      const scan = () => {
        caches.forEach((cache, cacheIndex) => {
          for (const id in cache) {
            const scanId = cacheIndex + ':' + id;
            if (scanned.has(scanId)) continue;
            const module = cache[id];
            const exports = module?.exports;
            if (exports == null || module.loaded === false) continue;
            scanned.add(scanId);

            addCandidate(exports);
            if (typeof exports !== 'object') continue;
            let keys;
            try {
              keys = Object.keys(exports);
            } catch (e) {
              continue;
            }
            for (const key of keys) {
              let value;
              try {
                value = exports[key];
              } catch (e) {
                continue;
              }
              addCandidate(value);
            }
          }
        });
      };

      const find = (filter) => {
        scan();
        for (const candidate of candidates) {
          try {
            if (filter(candidate)) return candidate;
          } catch (e) {}
        }
        return null;
      };
      const findByProps = (propNames) =>
        find((module) => propNames.every((prop) => module[prop] !== undefined));
      const findStore = (name) =>
        find((module) => typeof module === 'object' && module.constructor?.displayName === name);

      return (this.cachedWebpack = { find, findByProps, findStore });
    },

    Sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    ReadFile: (file) =>
      new Promise((resolve, reject) => {
        let fileReader = new FileReader();
        fileReader.onload = () => resolve(fileReader.result);
        fileReader.onerror = () => reject(fileReader.error);
        fileReader.readAsArrayBuffer(file);
      }),
    HostDownloadFile: (url) => {
      if (host.fetchBinary != null) return host.fetchBinary(url);
      if (typeof GM_xmlhttpRequest !== 'undefined')
        return new Promise((resolve, reject) => {
          GM_xmlhttpRequest({
            method: 'GET',
            url,
            responseType: 'arraybuffer',
            onload: (result) =>
              result.status >= 200 && result.status < 300
                ? resolve(result.response)
                : reject(new Error(`HTTP ${result.status}`)),
            onerror: reject,
          });
        });
      return null;
    },
    ToArrayBuffer: (data) => {
      // compare tags, not instanceof: the data may come from another realm (userscript sandbox, IPC)
      const tag = Object.prototype.toString.call(data);
      if (tag === '[object ArrayBuffer]') return data;
      if (ArrayBuffer.isView(data)) return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
      throw new Error('download returned no data');
    },
    // Discord's CDN doesn't allow cross-origin reads of attachments, so the page can't fetch them.
    // Every host provides a privileged download (GM_xmlhttpRequest, extension rule, Vencord native,
    // BdApi.Net); plain fetch is only the last resort.
    DownloadFile: async function (url) {
      let hostError = null;
      const hostPromise = this.HostDownloadFile(url);
      if (hostPromise != null) {
        try {
          return this.ToArrayBuffer(await hostPromise);
        } catch (e) {
          hostError = e;
        }
      }
      try {
        const response = await fetch(url, { credentials: 'omit' });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return await response.arrayBuffer();
      } catch (e) {
        throw hostError ?? e;
      }
    },

    DownloadBlob: (filename, blob) => {
      let url = URL.createObjectURL(blob);
      Utils.DownloadUrl(filename, url);
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    },
    DownloadUrl: (filename, url) => {
      let a = document.createElement('a');
      a.href = url;
      a.download = filename;
      a.style.display = 'none';
      document.body.appendChild(a);
      a.click();
      a.remove();
    },

    TryCompress: (buffer) =>
      new Promise((resolve) => {
        let length = buffer.byteLength;
        if (length < 1600) return resolve(buffer);
        let bufferView = new DataView(buffer);
        let pixelCount = Math.ceil(length / 3);
        const maxSafePngWidth = 32767;
        let lines = Math.ceil(pixelCount / maxSafePngWidth);
        let width = Math.ceil(pixelCount / lines);
        let fullPixelCount = lines * width;
        let pixelBytes = new Uint8ClampedArray(fullPixelCount * 4);
        let pixels = new DataView(pixelBytes.buffer);
        let pixelMaxIndex = pixelCount - 1;
        let remainingBytes = length - pixelMaxIndex * 3;
        let i = pixelMaxIndex;
        while (i--) {
          let pixel = bufferView.getUint32(i * 3, true) | 0xff000000; //3 bytes per pixel, alpha is 255
          pixels.setUint32(i * 4, pixel, true);
        }
        if (remainingBytes === 3) {
          let pixel =
            bufferView.getUint16(length - 3, true) |
            (bufferView.getUint8(length - 1) << 16) |
            0xff000000;
          pixels.setUint32(pixelMaxIndex * 4, pixel, true);
        } else if (remainingBytes === 2) {
          let pixel = bufferView.getUint16(length - 2, true) | 0xff000000;
          pixels.setUint32(pixelMaxIndex * 4, pixel, true);
        } else if (remainingBytes === 1) {
          let pixel = bufferView.getUint8(length - 1) | 0xff000000;
          pixels.setUint32(pixelMaxIndex * 4, pixel, true);
        }
        let canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = lines;
        let ctx = canvas.getContext('2d');
        ctx.putImageData(new ImageData(pixelBytes, width, lines), 0, 0);
        let fileReader = new FileReader();
        fileReader.onload = () => {
          let buffer = fileReader.result;
          let view = new DataView(buffer);
          view.setUint16(0, 0x5dc, false); //signature: 05 DC
          view.setUint32(2, length, true);
          resolve(buffer);
        };
        canvas.toBlob((blob) => fileReader.readAsArrayBuffer(blob), 'image/png');
      }),
    TryDecompress: async (buffer) => {
      let bufferView = new DataView(buffer);
      if (buffer.byteLength < 2 || bufferView.getUint16(0, false) !== 0x5dc) return buffer;
      let length = bufferView.getUint32(2, true);
      bufferView.setUint16(0, 0x8950, false);
      bufferView.setUint32(2, 0x4e470d0a, false); //restore original PNG signature

      let bitmap = await createImageBitmap(new Blob([buffer], { type: 'image/png' }));
      let canvas = document.createElement('canvas');
      let ctx = canvas.getContext('2d');
      let width = (canvas.width = bitmap.width);
      let height = (canvas.height = bitmap.height);
      ctx.drawImage(bitmap, 0, 0);
      let pxbuffer = ctx.getImageData(0, 0, width, height).data.buffer;
      let pxbufferView = new DataView(pxbuffer);
      let pixelCount = Math.ceil(length / 3);
      for (let i = 0; i < pixelCount; i++) {
        pxbufferView.setUint32(i * 3, pxbufferView.getUint32(i * 4, true), true);
      }
      return pxbuffer.slice(0, length);
    },

    GetNonce: () => (BigInt(Date.now() - 14200704e5 /*DISCORD_EPOCH*/) << BigInt(22)).toString(),

    FormatTime: (timestamp) => {
      if (!timestamp) return 'never';
      let timezoneOffset = new Date().getTimezoneOffset() * 60000;
      let dateNow = new Date(Date.now() - timezoneOffset).toISOString().slice(0, 10);
      let datetime = new Date(timestamp - timezoneOffset).toISOString();
      let date = datetime.slice(0, 10);
      let time = datetime.slice(11, 16);
      return `${date === dateNow ? 'today at' : date} ${time}`;
    },

    Intersect: (a, b) => {
      let ai = 0,
        bi = 0;
      let alen = a.length,
        blen = b.length;
      let result = [];
      while (ai < alen && bi < blen) {
        if (a[ai] < b[bi]) ai++;
        else if (a[ai] > b[bi]) bi++;
        else {
          result.push(a[ai]);
          ai++;
          bi++;
        }
      }
      return result;
    },

    Sha512: async (buffer) => await crypto.subtle.digest('SHA-512', buffer),
    Sha512_128: async (buffer) => (await crypto.subtle.digest('SHA-512', buffer)).slice(0, 16),
    Sha512_128str: async function (string) {
      return await this.Sha512_128(this.StringToUtf8Bytes(string));
    },
    Sha512_256: async (buffer) => (await crypto.subtle.digest('SHA-512', buffer)).slice(0, 32),
    Sha512_256str: async function (string) {
      return await this.Sha512_256(this.StringToUtf8Bytes(string));
    },

    AesImportKey: async (buffer) =>
      await crypto.subtle.importKey('raw', buffer, 'AES-CBC', false, ['encrypt', 'decrypt']),
    AesEncrypt: async function (key, buffer) {
      let initializationVector = this.GetRandomBytes(16);
      let encryptedBuffer = await crypto.subtle.encrypt(
        { name: 'AES-CBC', iv: initializationVector },
        key,
        buffer
      );
      return this.ConcatBuffers([initializationVector, encryptedBuffer]);
    },
    AesDecrypt: async function (key, buffer) {
      let initializationVector = buffer.slice(0, 16);
      let encryptedBuffer = buffer.slice(16);
      return await crypto.subtle.decrypt(
        { name: 'AES-CBC', iv: initializationVector },
        key,
        encryptedBuffer
      );
    },
    AesEncryptString: async function (key, string) {
      return await this.AesEncrypt(key, this.StringToUtf8Bytes(string));
    },
    AesDecryptString: async function (key, buffer) {
      return this.Utf8BytesToString(await this.AesDecrypt(key, buffer));
    },
    AesEncryptCompressString: async function (key, string) {
      let buffer = await this.TryCompress(this.StringToUtf8Bytes(string).buffer);
      return await this.AesEncrypt(key, buffer);
    },
    AesDecryptDecompressString: async function (key, string) {
      let buffer = await this.TryDecompress(await this.AesDecrypt(key, string));
      return this.Utf8BytesToString(buffer);
    },

    DhGenerateKeys: async () =>
      await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-521' }, true, ['deriveBits']),
    DhImportPublicKey: async (buffer) =>
      await crypto.subtle.importKey('raw', buffer, { name: 'ECDH', namedCurve: 'P-521' }, false, []),
    DhImportPrivateKey: async (buffer) =>
      await crypto.subtle.importKey('pkcs8', buffer, { name: 'ECDH', namedCurve: 'P-521' }, false, [
        'deriveBits',
      ]),
    DhImportPrivateKeyFallback: async function (buffer) {
      return await crypto.subtle.importKey(
        'jwk',
        JSON.parse(this.Utf8BytesToString(buffer)),
        { name: 'ECDH', namedCurve: 'P-521' },
        false,
        ['deriveBits']
      );
    },
    DhExportPublicKey: async (key) => await crypto.subtle.exportKey('raw', key),
    DhExportPrivateKey: async (key) => await crypto.subtle.exportKey('pkcs8', key),
    DhExportPrivateKeyFallback: async function (key) {
      return this.StringToUtf8Bytes(JSON.stringify(await crypto.subtle.exportKey('jwk', key)));
    },
    DhGetSecret: async (privateKey, publicKey) =>
      await crypto.subtle.deriveBits(
        { name: 'ECDH', namedCurve: 'P-521', public: publicKey },
        privateKey,
        256
      ),

    utf8encoder: new TextEncoder(),
    utf8decoder: new TextDecoder(),
    StringToUtf8Bytes: function (string) {
      return this.utf8encoder.encode(string);
    },
    Utf8BytesToString: function (buffer) {
      return this.utf8decoder.decode(buffer);
    },

    BytesToBase64: (buffer) => {
      const bytes = new Uint8Array(buffer);
      let binary = '';
      for (let i = 0; i < bytes.length; i += 0x8000)
        binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
      return btoa(binary);
    },
    Base64ToBytes: (string) => Uint8Array.from(atob(string), (c) => c.charCodeAt(0)),

    BytesToBase64url: function (buffer) {
      return this.BytesToBase64(buffer).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
    },
    Base64urlToBytes: function (string) {
      return this.Base64ToBytes(string.replace(/\-/g, '+').replace(/_/g, '/'));
    },

    GetRandomBytes: (n) => crypto.getRandomValues(new Uint8Array(n)),
    GetRandomUints: (n) => crypto.getRandomValues(new Uint32Array(n)),

    ConcatBuffers: (buffers) => {
      let newLength = buffers.reduce((len, x) => len + x.byteLength, 0);
      let newBuffer = new Uint8Array(newLength);

      let currentOffset = 0;
      for (let buffer of buffers) {
        newBuffer.set(new Uint8Array(buffer), currentOffset);
        currentOffset += buffer.byteLength;
      }

      return newBuffer;
    },

    // Bytes are carried as braille characters (U+2800 + byte)
    PayloadEncode: (buffer) => {
      const bytes = new Uint8Array(buffer);
      let result = '';
      for (let i = 0; i < bytes.length; i += 0x8000)
        result += String.fromCharCode.apply(
          null,
          Uint16Array.from(bytes.subarray(i, i + 0x8000), (b) => b + 0x2800)
        );
      return result;
    },
    PayloadDecode: (string) => Uint8Array.from(string, (c) => c.charCodeAt(0) - 0x2800),

    // Called for every window we show: password show/hide, and keeps Discord from
    // swallowing keystrokes or pulling focus back to the chat box while it's open.
    SetupDialog: function (wrapper) {
      const stop = (e) => e.stopPropagation();
      for (const type of ['keydown', 'keyup', 'keypress', 'paste', 'copy', 'cut'])
        wrapper.addEventListener(type, stop);

      for (const button of wrapper.getElementsByClassName('E2EE_SHOWPASS')) {
        const input = button.parentElement.querySelector('input');
        button.addEventListener('mousedown', (e) => e.preventDefault()); // keep focus in the input
        button.addEventListener('click', () => {
          const show = input.type === 'password';
          input.type = show ? 'text' : 'password';
          button.textContent = show ? 'Hide' : 'Show';
          input.focus();
        });
      }

      const input = wrapper.getElementsByClassName('E2EE_PASSWORD')[0];
      if (input == null) return;
      let pointerOutside = false;
      const onPointerDown = (e) => {
        pointerOutside = !wrapper.contains(e.target);
      };
      const onFocusIn = (e) => {
        if (!wrapper.isConnected) return cleanup();
        // something (usually Discord's chat box) grabbed focus without the user clicking it
        if (!wrapper.contains(e.target) && !pointerOutside) setTimeout(() => input.focus(), 0);
      };
      const cleanup = () => {
        document.removeEventListener('pointerdown', onPointerDown, true);
        document.removeEventListener('focusin', onFocusIn, true);
      };
      document.addEventListener('pointerdown', onPointerDown, true);
      document.addEventListener('focusin', onFocusIn, true);
      wrapper.__e2eeCleanup = cleanup;
      input.focus();
      setTimeout(() => input.focus(), 60);
      setTimeout(() => input.focus(), 400);
    },
    CloseDialog: (element) => {
      if (element == null) return;
      element.__e2eeCleanup?.();
      element.remove();
    },

    AttachEventToClass: (rootElement, className, eventName, callback) => {
      for (let element of rootElement.getElementsByClassName(className))
        element.addEventListener(eventName, callback);
    },

    trimKeyCache: () => {
      let keyHashes = Object.keys(Cache.keys);
      if (keyHashes.length < 200) return;
      let lastseen = Number.MAX_SAFE_INTEGER;
      let keyToTrim = keyHashes[0];
      for (let hash of keyHashes) {
        let key = DataBase.keys[hash];
        if (key == null) {
          keyToTrim = hash;
          break;
        }
        if (key.l < lastseen) {
          keyToTrim = hash;
          lastseen = key.l;
        }
      }
      delete Cache.keys[keyToTrim];
    },
    GetKeyByHash: async function (hashBase64, out) {
      let keyObj = DataBase.keys[hashBase64];
      if (keyObj == null) return null;
      if (out != null) out[0] = keyObj;
      keyObj.l = Date.now(); //lastseen
      this.dbChanged = true;

      let cachedKey = Cache.keys[hashBase64];
      if (cachedKey != null) return cachedKey;

      let keyBytes = this.Base64ToBytes(keyObj.k);
      if (DataBase.isEncrypted) keyBytes = await this.AesDecrypt(Cache.dbKey, keyBytes);

      let key = await this.AesImportKey(keyBytes);
      this.trimKeyCache();
      Cache.keys[hashBase64] = key;
      return key;
    },
    GetKeyBytesByHash: async function (hashBase64) {
      let keyObj = DataBase.keys[hashBase64];
      if (keyObj == null) return null;
      keyObj.l = Date.now(); //lastseen
      this.dbChanged = true;

      let keyBytes = this.Base64ToBytes(keyObj.k);
      if (DataBase.isEncrypted) keyBytes = await this.AesDecrypt(Cache.dbKey, keyBytes);

      return keyBytes;
    },
    SaveKey: async function (keyBytes, type, descriptor, hidden) {
      let keyHashBase64 = this.BytesToBase64(await this.Sha512_128(keyBytes));
      if (DataBase.keys[keyHashBase64] != null) return keyHashBase64;
      let keyObj = {
        t: type,
        d: descriptor,
        r /*registered*/: Date.now(),
        l /*lastseen*/: Date.now(),
        h /*hidden*/: hidden || type > 1 ? 1 : 0,
      };

      if (DataBase.isEncrypted) keyBytes = await this.AesEncrypt(Cache.dbKey, keyBytes);

      keyObj.k = this.BytesToBase64(keyBytes);
      DataBase.keys[keyHashBase64] = keyObj;
      this.FastSaveDb();
      return keyHashBase64;
    },

    dbChanged: false,
    LoadDb: function (callback, failCallback, reload) {
      (async () => {
        if (!reload) {
          DataBase = await Storage.get(DbStorageKey);
          if (DataBase == null) {
            for (const legacyKey of LegacyDbStorageKeys) {
              const legacy = await LoadLegacyDb(legacyKey);
              if (legacy != null && typeof legacy === 'object' && legacy.keys != null) {
                Utils.Log(`imported your existing ${legacyKey} database`);
                DataBase = legacy;
                this.dbChanged = true;
                break;
              }
            }
          }
        }
        if (DataBase != null) {
          Cache = { keys: {} };
          if (DataBase.channels == null) DataBase.channels = {};
          if (DataBase.keys == null) DataBase.keys = {};

          if (DataBase.isEncrypted) {
            const newdbCallback = () => {
              this.NewDb(callback, failCallback);
            };
            const passwordCallback = async (password) => {
              if (
                this.BytesToBase64(await this.Sha512_128str(password + DataBase.dbPasswordSalt)) ===
                DataBase.dbPasswordHash
              ) {
                Cache.dbKey = await this.AesImportKey(
                  await this.Sha512_256str(password + DataBase.dbKeySalt)
                );
                this.SaveDb();
                if (callback) callback();
              } else UnlockWindow.Show(passwordCallback, newdbCallback, failCallback, true);
            };

            UnlockWindow.Show(passwordCallback, newdbCallback, failCallback);
          } else {
            this.SaveDb();
            if (callback) callback();
          }
        } else {
          this.NewDb(callback, failCallback);
        }
      })().catch((e) => {
        Utils.Error('failed to load the database', e);
        if (failCallback) failCallback();
      });
    },
    SaveDb: async function () {
      if (!this.dbChanged || DataBase == null) return;
      this.dbChanged = false;
      try {
        await Storage.set(DbStorageKey, DataBase);
      } catch (e) {
        this.dbChanged = true;
        Utils.Error('failed to save the database', e);
      }
    },
    saveDbTimeout: null,
    FastSaveDb: function () {
      this.dbChanged = true;
      if (this.saveDbTimeout != null) clearTimeout(this.saveDbTimeout);
      this.saveDbTimeout = setTimeout(() => {
        this.saveDbTimeout = null;
        this.SaveDb();
      }, 10);
    },

    DownloadDb: async function (uncompressed) {
      let buffer = this.StringToUtf8Bytes(JSON.stringify(DataBase)).buffer;
      if (!uncompressed) buffer = await this.TryCompress(buffer);
      this.DownloadBlob(
        uncompressed ? `${ExportBaseName}.json` : `${ExportBaseName}.dat`,
        new Blob([buffer])
      );
    },
    fileInput: (() => {
      //need reference to keep gc away
      let fileInput = document.createElement('input');
      fileInput.type = 'file';
      return fileInput;
    })(),
    ImportDb: function (callback, secondary) {
      this.fileInput.accept = '.json,.dat';
      this.fileInput.value = '';
      this.fileInput.onchange = async () => {
        try {
          let buffer = await this.ReadFile(this.fileInput.files[0]);
          const imported = JSON.parse(this.Utf8BytesToString(await this.TryDecompress(buffer)));
          if (imported == null || typeof imported !== 'object' || imported.keys == null)
            throw new Error('not a database file');
          DataBase = imported;
          if (secondary) DataBase.isSecondary = true;
          else delete DataBase.isSecondary;
          this.FastSaveDb();
          this.LoadDb(callback, null, true);
        } catch (e) {
          Utils.Error('import failed', e);
          PopupManager.Notice(`That file is not a valid ${AppName} database.`);
        }
      };
      this.fileInput.click();
    },

    NewDb: function (callback, cancelCallback) {
      NewdbWindow.Show(
        async (password) => {
          DataBase = {
            isEncrypted: password !== '',
            keys: {},
            channels: {},
            autoKeyExchange: 'ask', // 'DM+friends' = automatic with friends, ask everyone else
          };
          Cache = { keys: {} };
          if (DataBase.isEncrypted) {
            let salts = this.GetRandomUints(2);
            DataBase.dbPasswordSalt = salts[0];
            DataBase.dbKeySalt = salts[1];

            DataBase.dbPasswordHash = this.BytesToBase64(
              await this.Sha512_128str(password + DataBase.dbPasswordSalt)
            );
            Cache.dbKey = await this.AesImportKey(
              await this.Sha512_256str(password + DataBase.dbKeySalt)
            );
          }

          await this.NewPersonalKey();
          await this.NewDhKeys();
          this.FastSaveDb();
          if (callback) callback();
        },
        () => {
          this.ImportDb(() => {
            NewdbWindow.Remove();
            if (callback) callback();
          });
        },
        () => {
          this.ImportDb(() => {
            NewdbWindow.Remove();
            if (callback) callback();
          }, true);
        },
        cancelCallback
      );
    },
    NewDbPassword: function (callback) {
      NewPasswordWindow.Show(async (password) => {
        let newDataBase = Object.assign({}, DataBase);
        let newDbKey = null;
        let oldDbKey = Cache.dbKey;
        newDataBase.isEncrypted = password !== '';
        if (newDataBase.isEncrypted) {
          let salts = this.GetRandomUints(2);
          newDataBase.dbPasswordSalt = salts[0];
          newDataBase.dbKeySalt = salts[1];

          newDataBase.dbPasswordHash = this.BytesToBase64(
            await this.Sha512_128str(password + newDataBase.dbPasswordSalt)
          );
          newDbKey = await this.AesImportKey(
            await this.Sha512_256str(password + newDataBase.dbKeySalt)
          );

          let keys = {};
          let dhKeyBytes;
          if (DataBase.isEncrypted) {
            //re-encrypt keys
            for (let [keyHash, oldKey] of Object.entries(DataBase.keys)) {
              let newKey = Object.assign({}, oldKey);
              let keyBytes = await this.AesDecrypt(oldDbKey, this.Base64ToBytes(oldKey.k /*key*/));
              newKey.k = this.BytesToBase64(await this.AesEncrypt(newDbKey, keyBytes));
              keys[keyHash] = newKey;
            }
            dhKeyBytes = await this.AesDecrypt(oldDbKey, this.Base64ToBytes(DataBase.dhPrivateKey));
          } else {
            //encrypt keys
            for (let [keyHash, oldKey] of Object.entries(DataBase.keys)) {
              let newKey = Object.assign({}, oldKey);
              let keyBytes = this.Base64ToBytes(oldKey.k /*key*/);
              newKey.k = this.BytesToBase64(await this.AesEncrypt(newDbKey, keyBytes));
              keys[keyHash] = newKey;
            }
            dhKeyBytes = this.Base64ToBytes(DataBase.dhPrivateKey);
          }
          newDataBase.dhPrivateKey = this.BytesToBase64(await this.AesEncrypt(newDbKey, dhKeyBytes));
          newDataBase.keys = keys;
        } else if (DataBase.isEncrypted) {
          //decrypt keys
          delete newDataBase.dbPasswordSalt;
          delete newDataBase.dbKeySalt;
          delete newDataBase.dbPasswordHash;
          let keys = {};
          for (let [keyHash, oldKey] of Object.entries(DataBase.keys)) {
            let newKey = Object.assign({}, oldKey);
            let keyBytes = await this.AesDecrypt(oldDbKey, this.Base64ToBytes(oldKey.k /*key*/));
            newKey.k = this.BytesToBase64(keyBytes);
            keys[keyHash] = newKey;
          }
          let dhKeyBytes = await this.AesDecrypt(oldDbKey, this.Base64ToBytes(DataBase.dhPrivateKey));
          newDataBase.dhPrivateKey = this.BytesToBase64(dhKeyBytes);
          newDataBase.keys = keys;
        }

        DataBase = newDataBase;
        Cache.dbKey = newDbKey;
        Cache.keys = {};
        this.FastSaveDb();
        if (callback) callback();
      });
    },
    NewDhKeys: async function () {
      let dhKeys = await this.DhGenerateKeys();
      let dhPrivateKeyBytes;
      let dhPrivateKeyFallback = false;
      try {
        dhPrivateKeyBytes = await this.DhExportPrivateKey(dhKeys.privateKey);
      } catch (e) {
        dhPrivateKeyBytes = await this.DhExportPrivateKeyFallback(dhKeys.privateKey);
        dhPrivateKeyFallback = true;
      }

      let dhPublicKeyBytes = await this.DhExportPublicKey(dhKeys.publicKey);

      if (DataBase.isEncrypted)
        dhPrivateKeyBytes = await this.AesEncrypt(Cache.dbKey, dhPrivateKeyBytes);

      if (dhPrivateKeyFallback) DataBase.dhPrivateKeyFallback = true;
      else delete DataBase.dhPrivateKeyFallback;
      DataBase.dhPrivateKey = this.BytesToBase64(dhPrivateKeyBytes);
      DataBase.dhPublicKey = this.BytesToBase64(dhPublicKeyBytes);
      this.FastSaveDb();
    },
    ReadDhKey: async function () {
      let dhPrivateKeyBytes = this.Base64ToBytes(DataBase.dhPrivateKey);
      if (DataBase.isEncrypted)
        dhPrivateKeyBytes = await this.AesDecrypt(Cache.dbKey, dhPrivateKeyBytes);

      if (DataBase.dhPrivateKeyFallback) {
        let dhPrivateKey = await this.DhImportPrivateKeyFallback(dhPrivateKeyBytes);
        try {
          dhPrivateKeyBytes = await this.DhExportPrivateKey(dhPrivateKey);
          if (DataBase.isEncrypted)
            dhPrivateKeyBytes = await this.AesEncrypt(Cache.dbKey, dhPrivateKeyBytes);

          delete DataBase.dhPrivateKeyFallback;
          DataBase.dhPrivateKey = this.BytesToBase64(dhPrivateKeyBytes);
        } catch (e) {}

        return dhPrivateKey;
      } else return await this.DhImportPrivateKey(dhPrivateKeyBytes);
    },
    ChangeKeyDescriptor: function (hash, descriptor) {
      DataBase.keys[hash].d = descriptor.replace(/[`\r\n]/g, '').substr(0, 250);
      this.FastSaveDb();
    },
    ChangeKeyHidden: function (hash, hidden) {
      DataBase.keys[hash].h = hidden ? 1 : 0;
      this.FastSaveDb();
    },
    DeleteKey: async function (hash) {
      if (hash === DataBase.personalKeyHash) {
        await this.NewPersonalKey();
        return;
      }
      this.ReplaceChannelKeys(hash, DataBase.personalKeyHash);
      delete DataBase.keys[hash];
      delete Cache.keys[hash];
      if (DataBase.trustedKeys != null && DataBase.trustedKeys[hash]) {
        delete DataBase.trustedKeys[hash];
        if (Object.keys(DataBase.trustedKeys).length === 0) delete DataBase.trustedKeys;
      }
      this.FastSaveDb();
    },
    ReplaceChannelKeys: function (oldHash, newHash) {
      Object.values(DataBase.channels).forEach((x) => {
        if (x.k === oldHash) x.k = newHash;
      });
      this.FastSaveDb();
    },
    NewPersonalKey: async function () {
      if (DataBase.personalKeyHash != null && DataBase.keys[DataBase.personalKeyHash] != null)
        this.ChangeKeyDescriptor(DataBase.personalKeyHash, 'Old personal key');
      let newPersonalKeyHash = await this.SaveKey(
        this.GetRandomBytes(32),
        3 /*personal*/,
        '#Your personal key#'
      );
      if (DataBase.personalKeyHash != null)
        this.ReplaceChannelKeys(DataBase.personalKeyHash, newPersonalKeyHash);
      DataBase.personalKeyHash = newPersonalKeyHash;
      this.FastSaveDb();
    },
    ToggleKeyTrusted: function (hash) {
      let keyObj = DataBase.keys[hash];
      if (keyObj == null || keyObj.t /*type*/ === 3 /*personal*/) return;
      if (DataBase.trustedKeys == null) DataBase.trustedKeys = {};
      if (DataBase.trustedKeys[hash]) {
        delete DataBase.trustedKeys[hash];
        if (Object.keys(DataBase.trustedKeys).length === 0) delete DataBase.trustedKeys;
      } else DataBase.trustedKeys[hash] = 1;
      this.FastSaveDb();
    },

    UserName: function (user) {
      if (user == null) return null;
      return user.globalName || user.global_name || user.username || null;
    },
    UserTag: function (user) {
      if (user == null) return 'someone';
      if (user.username == null && user.id != null) user = Discord.getUser(user.id) || user;
      const handle =
        user.username == null
          ? null
          : user.discriminator && user.discriminator !== '0'
          ? `${user.username}#${user.discriminator}`
          : `@${user.username}`;
      const name = this.UserName(user);
      if (handle == null) return name || user.id || 'someone';
      return name && name !== user.username ? `${name} (${handle})` : handle;
    },

    FormatDescriptor: function (descriptor) {
      return String(descriptor ?? '')
        .replace(/<@(\d{1,20})>/g, (m, x) => {
          let user = Discord.getUser(x);
          return (user != null && this.UserName(user)) || x;
        })
        .replace(/<#(\d{1,20})>/g, (m, x) => {
          let channel = Discord.getChannel(x);
          if (channel == null) return m;
          if (channel.guild_id == null) return channel.name || m;
          let guild = Discord.getGuild?.(channel.guild_id);
          return guild != null ? `${guild.name} #${channel.name}` : `#${channel.name}`;
        });
    },

    GetChannelConfig: function (channelId) {
      let channelConfig = DataBase.channels[channelId];
      if (channelConfig != null) {
        channelConfig.l = Date.now();
        this.dbChanged = true;
      }
      return channelConfig;
    },
    GetOrCreateChannelConfig: function (channelId) {
      let channelConfig = DataBase.channels[channelId];
      if (channelConfig != null) {
        channelConfig.l = Date.now();
        this.dbChanged = true;
        return channelConfig;
      }
      return this.NewChannelConfig(channelId);
    },
    NewChannelConfig: function (channelId, keyHash, descriptor, encrypt) {
      let channelConfig = {
        k: keyHash || DataBase.personalKeyHash,
        e: encrypt ? 1 : 0,
        l: Date.now(),
      };
      if (descriptor != null) channelConfig.d = descriptor;
      else {
        let channel = Discord.getChannel(channelId);
        if (channel != null && channel.type === 1)
          channelConfig.d = `DM with <@${channel.recipients?.[0] ?? channel.getRecipientId?.()}>`;
        else channelConfig.d = `<#${channelId}>`;
      }
      DataBase.channels[channelId] = channelConfig;
      this.FastSaveDb();
      return channelConfig;
    },
    DeleteChannelConfig: function (channelId) {
      if (Cache.channelId === channelId) Cache.channelConfig = null;
      delete DataBase.channels[channelId];
      this.FastSaveDb();
    },
    GetChannelBlacklist: function (channelId) {
      if (Blacklist == null || channelId == null) return null;
      if (channelId === Cache.channelId && Cache.channelBlacklist !== undefined)
        return Cache.channelBlacklist;
      const guildId = Discord.getChannel(channelId)?.guild_id;
      return guildId == null ? null : Blacklist[guildId] ?? null;
    },
    GetCurrentChannelKeyHash: () => {
      return Cache.channelConfig != null ? Cache.channelConfig.k : DataBase.personalKeyHash;
    },
    GetCurrentChannelEncrypt: () => {
      return Cache.channelConfig != null && Cache.channelConfig.e && Cache.channelBlacklist !== 1;
    },
    ToggleCurrentChannelEncrypt: function () {
      if (Cache.channelBlacklist === 1 || Cache.channelId == null) return;

      if (Cache.channelConfig == null)
        Cache.channelConfig = this.NewChannelConfig(Cache.channelId, null, null, true);
      else {
        Cache.channelConfig.e = Cache.channelConfig.e ? 0 : 1;
        this.FastSaveDb();
      }

      this.ClearCurrentChannelAttachments();
    },
    SetCurrentChannelKey: async function (hash) {
      if (Cache.channelConfig == null)
        Cache.channelConfig = this.NewChannelConfig(Cache.channelId, hash, null, false);
      else {
        let oldKeyHash = Cache.channelConfig.k;
        if (hash === oldKeyHash) return;
        if (DataBase.keys[oldKeyHash]?.t /*type*/ === 2 /*conversation*/) {
          if (
            !(await PopupManager.NewPromise(
              `This DM is secured with a key exchange. Switch to a different key anyway?`,
              true
            ))
          )
            return;
        }
        Cache.channelConfig.k = hash;
        this.FastSaveDb();
      }

      this.ClearCurrentChannelAttachments();
    },
    SetChannelKey: function (channelId, hash) {
      let channelConfig = this.GetOrCreateChannelConfig(channelId);
      let oldKeyHash = channelConfig.k;
      if (hash === oldKeyHash) return;
      channelConfig.k = hash;
      this.FastSaveDb();

      this.ClearChannelAttachments(channelId);
    },
    GetCurrentChannelIsDm: () => Discord.getChannel(Cache.channelId)?.type === 1,
    GetCurrentDmUserId: () => {
      const channel = Discord.getChannel(Cache.channelId);
      return channel?.recipients?.[0] ?? channel?.getRecipientId?.();
    },
    RefreshCache: () => {
      Cache.channelId = Discord.getChannelId() ?? null;
      Cache.channelConfig = Cache.channelId != null ? DataBase.channels[Cache.channelId] : null;
      if (Cache.channelConfig != null) Cache.channelConfig.l = Date.now();
      if (Blacklist != null) {
        let channel = Discord.getChannel(Cache.channelId);
        if (channel == null) return false;
        let guildId = channel.guild_id;
        Cache.channelBlacklist = guildId == null ? null : Blacklist[guildId] ?? null;
      }
      return true;
    },

    ClearChannelAttachments(channelId) {
      if (channelId == null) return;
      Discord.dispatch({ type: 'UPLOAD_ATTACHMENT_CLEAR_ALL_FILES', channelId, draftType: 0 });
    },
    ClearCurrentChannelAttachments: function () {
      this.ClearChannelAttachments(Cache.channelId);
    },

    SendSystemMessage: function (channelId, sysmsg) {
      Discord.sendRaw(channelId, `${SystemMessageHeader}${sysmsg}\n${SystemTagLine}`);
    },
    SendPersonalKey: async function (channelId) {
      let channelConfig = this.GetChannelConfig(channelId);
      if (channelConfig == null) return;
      let keyHash = channelConfig.k;
      if (keyHash === DataBase.personalKeyHash) return;

      let keyHashPayload = this.PayloadEncode(this.Base64ToBytes(keyHash));
      let key = await this.GetKeyByHash(keyHash);
      let personalKey = await this.GetKeyBytesByHash(DataBase.personalKeyHash);
      let personalKeyPayload = this.PayloadEncode(await this.AesEncrypt(key, personalKey));

      this.SendSystemMessage(
        channelId,
        `*type*: \`PERSONAL KEY\`\n*key*: \`${keyHashPayload}\`\n*personalKey*: \`${personalKeyPayload}\``
      );

      delete channelConfig.w;
      this.dbChanged = true;
    },
    AddListener: (listenerMap, key, listener) => {
      let listeners = listenerMap[key];
      if (listeners == null) listenerMap[key] = [listener];
      else listeners.push(listener);
    },
    RemoveListener: (listenerMap, key, listener) => {
      let listeners = listenerMap[key];
      if (listeners == null) return;
      let index = listeners.indexOf(listener);
      if (index === -1) return;
      if (listeners.length === 1) {
        delete listenerMap[key];
        return;
      }
      listeners.splice(index, 1);
    },
    ListenerEvent: (listenerMap, key) => {
      let listeners = listenerMap[key];
      if (listeners == null) return;
      for (let listener of listeners.slice()) listener();
    },
    ListenerBulkEvent: function (listenerMap, keyList) {
      let listenerKeys = Object.keys(listenerMap);
      if (listenerKeys.length === 0 || !Array.isArray(keyList)) return;
      let foundKeys = this.Intersect(keyList.slice().sort(), listenerKeys.sort());
      for (let key of foundKeys) for (let listener of listenerMap[key].slice()) listener();
    },
    messageDeleteListeners: {},
    AddMessageDeleteListener: function (messageId, listener) {
      this.AddListener(this.messageDeleteListeners, messageId, listener);
    },
    RemoveMessageDeleteListener: function (messageId, listener) {
      this.RemoveListener(this.messageDeleteListeners, messageId, listener);
    },
    MessageDeleteEvent: function (messageId) {
      this.ListenerEvent(this.messageDeleteListeners, messageId);
    },
    MessageDeleteBulkEvent: function (messageIdList) {
      this.ListenerBulkEvent(this.messageDeleteListeners, messageIdList);
    },
    keyShareListeners: {},
    AddKeyShareListener: function (keyHash, listener) {
      this.AddListener(this.keyShareListeners, keyHash, listener);
    },
    RemoveKeyShareListener: function (keyHash, listener) {
      this.RemoveListener(this.keyShareListeners, keyHash, listener);
    },
    KeyShareEvent: function (keyHash) {
      this.ListenerEvent(this.keyShareListeners, keyHash);
    },
    keyExchangeListeners: {},
    AddKeyExchangeListener: function (userId, listener) {
      this.AddListener(this.keyExchangeListeners, userId, listener);
    },
    RemoveKeyExchangeListener: function (userId, listener) {
      this.RemoveListener(this.keyExchangeListeners, userId, listener);
    },
    KeyExchangeEvent: function (userId) {
      this.ListenerEvent(this.keyExchangeListeners, userId);
    },
    channelSelectListeners: {},
    AddChannelSelectListener: function (channelId, listener) {
      this.AddListener(this.channelSelectListeners, channelId, listener);
    },
    RemoveChannelSelectListener: function (channelId, listener) {
      this.RemoveListener(this.channelSelectListeners, channelId, listener);
    },
    ChannelSelectEvent: function (channelId) {
      this.ListenerEvent(this.channelSelectListeners, channelId);
    },
    // Automatic key exchanges send messages for you, so only skip the prompt when allowed
    NeedsKeyExchangeConsent: function (userId) {
      const mode = DataBase.autoKeyExchange;
      if (/friend/i.test(mode)) return !Discord.isFriend(userId);
      return mode !== 'always';
    },
    GetAutoKeyExchangeFriends: () => /friend/i.test(DataBase.autoKeyExchange),
    ToggleAutoKeyExchangeFriends: function () {
      DataBase.autoKeyExchange = this.GetAutoKeyExchangeFriends() ? 'ask' : 'DM+friends';
      this.FastSaveDb();
    },
    ongoingKeyExchanges: {},
    InitKeyExchange: async function (user, autoOnMessage, autoOnKey) {
      let userId = user.id;
      let currentUserId = Discord.getCurrentUser()?.id;
      if (userId == null || userId === currentUserId) return 0;

      let channelId = Discord.getDMFromUserId(userId);
      let channelConfig;
      if (autoOnMessage) {
        channelConfig = channelId != null ? this.GetChannelConfig(channelId) : null;
        if (
          channelConfig != null &&
          (channelConfig.s /*systemMessageTime*/ > 0 || channelConfig.w) /*waitingForSystemMessage*/
        )
          return 2;

        if (this.NeedsKeyExchangeConsent(userId)) {
          if (this.ongoingKeyExchanges[userId]) return 0;
          this.ongoingKeyExchanges[userId] = true;
          let popupOverride = {};
          let popup = PopupManager.NewPromise(
            `Start a secure key exchange with ${this.UserTag(user)}?`,
            false,
            popupOverride
          );
          const autoCancel = () => {
            delete this.ongoingKeyExchanges[userId];
            popupOverride.cancel();
          };
          this.AddMessageDeleteListener(autoOnMessage, autoCancel);
          this.AddKeyShareListener(autoOnKey, autoCancel);
          let force = await popup;
          this.RemoveMessageDeleteListener(autoOnMessage, autoCancel);
          this.RemoveKeyShareListener(autoOnKey, autoCancel);
          if (!force) return 0;
        }
      }
      delete this.ongoingKeyExchanges[userId]; //this way once canceled you either have to add them as friend or restart the plugin

      keyExchangeWhitelist[userId] = true;

      if (channelId == null) {
        channelId = await Discord.ensurePrivateChannel(userId);
        if (channelId == null) return 0;
      }

      let dhPublicKeyPayload = this.PayloadEncode(this.Base64ToBytes(DataBase.dhPublicKey));

      this.SendSystemMessage(channelId, `*type*: \`DH KEY\`\n*dhKey*: \`${dhPublicKeyPayload}\``);
      channelConfig = channelConfig || this.GetOrCreateChannelConfig(channelId);
      channelConfig.w = 1;
      this.dbChanged = true;
      return 1;
    },
    ongoingKeyRequests: {},
    RequestKey: async function (keyHash, user, autoOnMessage) {
      let userId = user.id;
      if (DataBase.keys[keyHash] != null) return false;

      let channelId = Discord.getDMFromUserId(userId);
      if (channelId == null) return false;

      let channelConfig;
      let requestId = keyHash + userId;
      if (autoOnMessage) {
        channelConfig = this.GetChannelConfig(channelId);
        if (channelConfig != null && channelConfig.w /*waitingForSystemMessage*/) return false;

        if (this.NeedsKeyExchangeConsent(userId)) {
          if (this.ongoingKeyRequests[requestId]) return false;
          if (this.ongoingKeyExchanges[userId]) return false;
          if (
            channelConfig == null ||
            DataBase.trustedKeys == null ||
            !DataBase.trustedKeys[channelConfig.k /*keyHash*/]
          ) {
            this.ongoingKeyRequests[requestId] = true;
            let popupOverride = {};
            let popup = PopupManager.NewPromise(
              `Ask ${this.UserTag(user)} for the key to their encrypted message?`,
              true,
              popupOverride
            );
            const autoCancel = () => {
              delete this.ongoingKeyRequests[requestId];
              popupOverride.cancel();
            };
            this.AddMessageDeleteListener(autoOnMessage, autoCancel);
            this.AddKeyShareListener(keyHash, autoCancel);
            let force = await popup;
            this.RemoveMessageDeleteListener(autoOnMessage, autoCancel);
            this.RemoveKeyShareListener(keyHash, autoCancel);
            if (!force) return false;
          }
        }
      }
      delete this.ongoingKeyRequests[requestId];

      keyExchangeWhitelist[userId] = true;

      let requestedKeyPayload = this.PayloadEncode(this.Base64ToBytes(keyHash));

      this.SendSystemMessage(
        channelId,
        `*type*: \`KEY REQUEST\`\n*requestedKey*: \`${requestedKeyPayload}\``
      );
      channelConfig = channelConfig || this.GetOrCreateChannelConfig(channelId);
      channelConfig.w = 1;
      this.dbChanged = true;
      return true;
    },
    ongoingKeyExchangesWithRequest: {},
    InitKeyExchangeAndRequestKey: async function (keyHash, user, autoOnMessage) {
      let requestId = keyHash + user.id;
      let ongoing = this.ongoingKeyExchangesWithRequest[requestId];
      if (ongoing && autoOnMessage) return false;
      let initKeyExchangeStatus = await this.InitKeyExchange(user, autoOnMessage, keyHash);
      if (initKeyExchangeStatus === 0) return false;
      if (ongoing) return false;
      this.ongoingKeyExchangesWithRequest[requestId] = true;
      let promiseResolve;
      if (initKeyExchangeStatus === 1) {
        await new Promise((resolve) => {
          promiseResolve = resolve;
          this.AddKeyExchangeListener(user.id, resolve);
        });
        this.RemoveKeyExchangeListener(user.id, promiseResolve);
      }
      if (await this.RequestKey(keyHash, user, initKeyExchangeStatus === 1 ? null : autoOnMessage)) {
        await new Promise((resolve) => {
          promiseResolve = resolve;
          this.AddKeyShareListener(keyHash, resolve);
        });
        this.RemoveKeyShareListener(keyHash, promiseResolve);
      }
      delete this.ongoingKeyExchangesWithRequest[requestId];
      return true;
    },
    ShareKey: async function (keyHash, channelId, nonForced, user) {
      let keyObj = DataBase.keys[keyHash];
      if (keyObj == null) {
        this.SendSystemMessage(channelId, `*type*: \`KEY SHARE\`\n*status*: \`NOT FOUND\``);
        return;
      }
      let channelConfig;
      if (nonForced != null && (nonForced || keyObj.h) /*hidden*/) {
        channelConfig = DataBase.channels[channelId];
        if (
          channelConfig == null ||
          DataBase.trustedKeys == null ||
          !DataBase.trustedKeys[channelConfig.k /*keyHash*/]
        ) {
          if (
            !(await PopupManager.NewPromise(
              `Share the key "${Utils.FormatDescriptor(keyObj.d)}" with ${this.UserTag(user)}?`,
              true
            ))
          ) {
            this.SendSystemMessage(channelId, `*type*: \`KEY SHARE\`\n*status*: \`DENIED\``);
            return;
          }
        }
      }

      let sharedKeyBytes = this.Base64ToBytes(keyObj.k);
      if (DataBase.isEncrypted) sharedKeyBytes = await this.AesDecrypt(Cache.dbKey, sharedKeyBytes);

      if (channelConfig == null) channelConfig = this.GetOrCreateChannelConfig(channelId);
      let key = await this.GetKeyByHash(channelConfig.k);
      let keyHashPayload = this.PayloadEncode(this.Base64ToBytes(channelConfig.k));

      let sharedKeyPayload = this.PayloadEncode(await Utils.AesEncrypt(key, sharedKeyBytes));

      if (keyHash === DataBase.personalKeyHash) {
        let keyDescriptor = `<@${Discord.getCurrentUser().id}>'s personal key`;
        this.SendSystemMessage(
          channelId,
          `*type*: \`KEY SHARE\`\n*status*: \`OK\`\n*key*: \`${keyHashPayload}\`\n*sharedKey*: \`${sharedKeyPayload}\`\n*keyType*: \`PERSONAL\`\n*keyDescriptor*: \`${keyDescriptor}\``
        );
      } else {
        const keyTypes = { 1: 'GROUP', 2: 'CONVERSATION', 3: 'PERSONAL' };
        let keyType = keyTypes[keyObj.t];
        let keyDescriptor = keyObj.d;
        let systemMessage = `*type*: \`KEY SHARE\`\n*status*: \`OK\`\n*key*: \`${keyHashPayload}\`\n*sharedKey*: \`${sharedKeyPayload}\`\n*keyType*: \`${keyType}\`\n*keyDescriptor*: \`${keyDescriptor}\``;
        if (keyObj.t === 1 /*group*/) {
          if (keyObj.h /*hidden*/) systemMessage += `\n*keyHidden*: \`YES\``;
          let sharedChannels = [];
          for (let [id, config] of Object.entries(DataBase.channels)) {
            if (config.k === keyHash) {
              let channel = Discord.getChannel(id);
              if (channel == null || channel.type === 1 /*DM*/) continue;

              if (sharedChannels.push(id) === 20) break;
            }
          }
          systemMessage += `\n*sharedChannels*: \`${JSON.stringify(sharedChannels)}\``;
        }

        this.SendSystemMessage(channelId, systemMessage);
      }

      delete channelConfig.w;
      this.dbChanged = true;
    },
    KeyRotationTimeout: function (keyHash, keyRotator, timeFromNow) {
      return setTimeout(async () => {
        delete DataBase.keyRotators[keyHash];
        delete KeyRotators[keyHash];
        let now = Date.now();
        let rotationCtr = Math.floor((now - keyRotator.start) / keyRotator.interval);
        let oldKey = DataBase.keys[keyHash];
        if (oldKey == null) {
          this.dbChanged = true;
          return;
        }
        let dhPrivateKeyBytes = this.Base64ToBytes(DataBase.dhPrivateKey);
        if (DataBase.isEncrypted)
          dhPrivateKeyBytes = await this.AesDecrypt(Cache.dbKey, dhPrivateKeyBytes);
        let seed = this.Base64ToBytes(keyRotator.seed);
        let newName = /^(.*?)(?: +\d+)?$/.exec(oldKey.d /*descriptor*/)[1] + ' ' + rotationCtr;
        let seedEdit = new DataView(seed.buffer);
        seedEdit.setUint32(0, seedEdit.getUint32(0, true) ^ rotationCtr, true);
        let newKeyHash = await this.SaveKey(
          await this.Sha512_256(this.ConcatBuffers([seed, dhPrivateKeyBytes])),
          1 /*group*/,
          newName,
          oldKey.h /*hidden*/
        );
        DataBase.keyRotators[newKeyHash] = keyRotator;
        oldKey.d /*descriptor*/ = 'Rotated ' + oldKey.d;
        this.dbChanged = true;
        this.ReplaceChannelKeys(keyHash, newKeyHash);
        if (Cache.channelConfig != null && Cache.channelConfig.k /*keyHash*/ === newKeyHash)
          MenuBar.Update();
        this.StartKeyRotation(newKeyHash, keyRotator);
      }, timeFromNow);
    },
    StartKeyRotation: function (keyHash, keyRotator) {
      let now = Date.now();
      let timeFromNow =
        keyRotator.start > now
          ? keyRotator.start - now
          : Math.ceil(
              (1 - (((now - keyRotator.start) / keyRotator.interval) % 1)) * keyRotator.interval
            );
      // setTimeout overflows above ~24.8 days; re-schedule in steps
      const maxTimeout = 0x7fffffff;
      if (timeFromNow > maxTimeout) {
        KeyRotators[keyHash] = setTimeout(
          () => this.StartKeyRotation(keyHash, keyRotator),
          maxTimeout
        );
        return;
      }
      KeyRotators[keyHash] = this.KeyRotationTimeout(keyHash, keyRotator, timeFromNow);
    },
    StopKeyRotation: (keyHash) => clearTimeout(KeyRotators[keyHash]),
    UpdateMessageContent: (message) => {
      if (message.edited_timestamp == null) {
        message.edited_timestamp = message.timestamp;
        Discord.dispatch({ type: 'MESSAGE_UPDATE', message });
        message.edited_timestamp = null; //in case the message is still loading when updated
      } else Discord.dispatch({ type: 'MESSAGE_UPDATE', message });
    },

    Can: (permission, user, context) => {
      try {
        if (Discord.can != null) return !!Discord.can({ permission, user, context });
        if (
          Discord.permissionStoreCan != null &&
          user != null &&
          user.id === Discord.getCurrentUser()?.id
        )
          return !!Discord.permissionStoreCan(permission, context);
      } catch (e) {}
      return false;
    },
  };

  var DataBase;
  var Cache = { keys: {} };
  var Blacklist;
  var KeyRotators = {};
  var ResolveInitPromise;
  var InitPromise = new Promise((resolve) => {
    ResolveInitPromise = resolve;
  });

  /* ───────────────────────────── Initialization ───────────────────────────── */

  var Initialized = false;
  var Loaded = false;
  var Active = false; // false while the database is locked or the plugin is unloaded

  function Init(final) {
    Discord = { window: PageWindow, modules: {} };

    if (!PageWindow.crypto || !crypto.subtle) {
      Utils.Error('Web Crypto API not available.');
      return -1;
    }

    const webpack = Utils.Webpack();
    if (webpack == null) {
      if (final) Utils.Warn('still waiting for Discord to load…');
      return 0;
    }
    const { find, findByProps, findStore } = webpack;
    const modules = Discord.modules;

    // Required
    modules.Dispatcher = find(
      (m) =>
        typeof m.dispatch === 'function' &&
        typeof m.subscribe === 'function' &&
        (typeof m.addInterceptor === 'function' || typeof m.wait === 'function')
    );
    modules.UserStore = findStore('UserStore') || findByProps(['getUser', 'getUsers', 'getCurrentUser']);
    modules.ChannelStore =
      findStore('ChannelStore') || findByProps(['getChannel', 'getDMFromUserId']);
    modules.SelectedChannelStore =
      findStore('SelectedChannelStore') ||
      findByProps(['getChannelId', 'getVoiceChannelId', 'getLastSelectedChannelId']);
    modules.MessageQueue = find(
      (m) => typeof m.enqueue === 'function' && typeof m.handleSend === 'function'
    );
    modules.MessageActions = find(
      (m) => typeof m.sendMessage === 'function' && typeof m.editMessage === 'function' && typeof m.receiveMessage === 'function'
    );

    const missing = [];
    if (modules.Dispatcher == null) missing.push('Dispatcher');
    if (modules.UserStore == null) missing.push('UserStore');
    if (modules.ChannelStore == null) missing.push('ChannelStore');
    if (modules.SelectedChannelStore == null) missing.push('SelectedChannelStore');
    if (modules.MessageQueue == null && modules.MessageActions == null)
      missing.push('MessageQueue/MessageActions');
    if (missing.length !== 0) {
      if (final) Utils.Warn(`waiting for Discord modules: ${missing.join(', ')}`);
      return 0;
    }

    // Optional — features degrade gracefully when these move
    modules.GuildStore = findStore('GuildStore') || findByProps(['getGuild', 'getGuildCount']);
    modules.GuildRoleStore = findStore('GuildRoleStore');
    modules.RelationshipStore =
      findStore('RelationshipStore') || findByProps(['isFriend', 'isBlocked', 'getFriendIDs']);
    modules.PrivateChannelActions = find(
      (m) =>
        typeof m.openPrivateChannel === 'function' &&
        (typeof m.ensurePrivateChannel === 'function' || typeof m.getOrEnsurePrivateChannel === 'function')
    );
    modules.PermissionStore = findStore('PermissionStore');
    modules.RestAPI = find(
      (m) => typeof m.get === 'function' && typeof m.post === 'function' && typeof m.put === 'function' && typeof m.del === 'function' && typeof m.patch === 'function'
    );
    modules.CloudUploadPrototype = find(
      (m) => typeof m === 'function' && typeof m.prototype?.uploadFileToCloud === 'function' && typeof m.prototype.upload === 'function'
    )?.prototype;
    modules.Premium = findByProps(['canUseEmojisEverywhere']);

    const canFunctionRegex =
      /^function \w*\(\w+\)\s*{\s*let\s*{\s*permission:\s*\w+,\s*user:\s*\w+,\s*context:/s;
    const functionToString = Function.prototype.toString;
    let permissionCan = null;
    find((m) => {
      if (typeof m !== 'object') return false;
      for (const key of Object.keys(m)) {
        const value = m[key];
        if (typeof value !== 'function') continue;
        let source;
        try {
          source = functionToString.call(value);
        } catch (e) {
          continue;
        }
        if (canFunctionRegex.test(source)) {
          permissionCan = value;
          return true;
        }
      }
      return false;
    });

    for (const name of ['GuildStore', 'RelationshipStore', 'PrivateChannelActions', 'CloudUploadPrototype']) {
      if (modules[name] == null) Utils.Warn(`${name} not found, some features are disabled`);
    }
    if (modules.CloudUploadPrototype == null)
      Utils.Warn('file encryption is unavailable in this Discord version — you will be asked before files are sent unencrypted');

    // Mirrors call the original functions directly, bypassing our hooks
    const mirror = (module, functionName, alias) => {
      alias = alias || functionName;
      const originalFunction = module?.[functionName];
      if (typeof originalFunction !== 'function') return false;
      Discord[`original_${alias}`] = originalFunction;
      Discord[alias] = function () {
        return originalFunction.apply(module, arguments);
      };
      return true;
    };
    const hookedAliases = [];
    const hook = (module, functionName, alias) => {
      alias = alias || functionName;
      const originalFunction = module[functionName];
      if (typeof originalFunction !== 'function') throw new Error(`${alias}() is invalid`);
      Discord[`original_${alias}`] = originalFunction;
      let detourFunction = originalFunction;
      Object.defineProperty(Discord, `detour_${alias}`, {
        get: () => detourFunction,
        set: (value) => (detourFunction = value),
        configurable: true,
      });
      const wrapper = function () {
        return Reflect.apply(detourFunction, this, arguments);
      };
      module[functionName] = wrapper;
      if (module[functionName] !== wrapper) throw new Error(`could not hook ${alias}()`);
      hookedAliases.push(alias);
    };
    Discord.hookedAliases = hookedAliases;

    try {
      mirror(modules.Dispatcher, 'dispatch');
      mirror(modules.UserStore, 'getUser');
      mirror(modules.UserStore, 'getCurrentUser');
      mirror(modules.ChannelStore, 'getChannel');
      mirror(modules.ChannelStore, 'getDMFromUserId');
      mirror(modules.SelectedChannelStore, 'getChannelId');
      if (!mirror(modules.GuildStore, 'getGuild')) Discord.getGuild = () => null;
      if (!mirror(modules.RelationshipStore, 'isFriend')) Discord.isFriend = () => false;

      const privateChannels = modules.PrivateChannelActions;
      Discord.ensurePrivateChannel = async (userId) => {
        if (privateChannels == null) return null;
        const ensure = privateChannels.ensurePrivateChannel || privateChannels.getOrEnsurePrivateChannel;
        let result = await ensure.call(privateChannels, userId);
        if (result != null && typeof result === 'object') result = result.id ?? result.channelId;
        return result ?? Discord.getDMFromUserId(userId);
      };

      Discord.can = permissionCan;
      if (modules.PermissionStore != null && typeof modules.PermissionStore.can === 'function')
        Discord.permissionStoreCan = (permission, channel) =>
          modules.PermissionStore.can(permission, channel);

      // Raw sender for key-exchange messages (never encrypted)
      if (modules.MessageQueue != null) mirror(modules.MessageQueue, 'enqueue');
      Discord.sendRaw = (channelId, content) => {
        if (host.dryRun) {
          Utils.Log('[dry run] not sending key exchange message to', channelId, content);
          return;
        }
        const nonce = Utils.GetNonce();
        if (Discord.enqueue != null) {
          Discord.enqueue(
            { type: 0 /*send*/, message: { channelId, content, nonce, tts: false } },
            () => {}
          );
        } else if (modules.RestAPI != null) {
          modules.RestAPI.post({
            url: `/channels/${channelId}/messages`,
            body: { content, nonce, tts: false },
          }).catch((e) => Utils.Error('failed to send a key exchange message', e));
        } else {
          const actions = modules.MessageActions;
          const rawMessage = { content, tts: false, invalidEmojis: [], validNonShortcutEmojis: [] };
          if (Discord.sendMessageName === '_sendMessage')
            Discord.original_sendMessage.call(actions, channelId, rawMessage, { nonce });
          else
            (Discord.original_sendMessage || actions.sendMessage).call(actions, channelId, rawMessage, true, { nonce });
        }
      };

      hook(modules.Dispatcher, 'dispatch');
      if (modules.MessageQueue != null) {
        hook(modules.MessageQueue, 'enqueue');
      } else {
        Utils.Warn('MessageQueue not found, using the MessageActions fallback');
        const sendName = typeof modules.MessageActions._sendMessage === 'function' ? '_sendMessage' : 'sendMessage';
        Discord.sendMessageName = sendName;
        hook(modules.MessageActions, sendName, 'sendMessage');
        hook(modules.MessageActions, 'editMessage');
      }
      if (modules.CloudUploadPrototype != null) {
        try {
          hook(modules.CloudUploadPrototype, 'upload', 'cloudUpload');
        } catch (e) {
          Utils.Warn('could not hook file uploads', e);
          modules.CloudUploadPrototype = null;
        }
      }
    } catch (err) {
      Utils.Error(err);
      return -1;
    }

    if (modules.Premium != null) {
      for (const name of ['canUseEmojisEverywhere', 'canUseAnimatedEmojis']) {
        if (typeof modules.Premium[name] !== 'function') continue;
        const descriptor = Object.getOwnPropertyDescriptor(modules.Premium, name);
        if (descriptor != null && !descriptor.writable && !descriptor.configurable) continue;
        if (Object.isFrozen(modules.Premium)) continue;
        try {
          hook(modules.Premium, name);
        } catch (e) {}
      }
    }

    Initialized = true;
    Style.Inject();

    LockMessages();
    Utils.LoadDb(
      () => {
        Load();
        UnlockMessages(true);
        ResolveInitPromise({ Load, Unload });
      },
      () => {
        Utils.Warn('no database unlocked — encryption is inactive until you reload');
        UnlockMessages(false);
      }
    );

    return 1;
  }

  /* ─────────────────────────── Incoming messages ─────────────────────────── */

  // Events that can carry messages. Anything matching is scanned for message objects,
  // which keeps us working when Discord reshapes payloads (pins, search, threads, …).
  const WalkEventRegex = /MESSAGE|SEARCH|PIN|MENTION|THREAD|FORUM|LOAD_|CONVERSATION|SAVED|INBOX/;
  const SkipWalkEventRegex =
    /DELETE|TYPING|ACK|REACTION|_EDIT$|_START$|_FAILURE$|_FAIL$|_CACHED$|_REQUEST$|LOCAL_MESSAGE_CREATE|MESSAGE_SEND/;

  function isCandidateContent(content) {
    if (typeof content !== 'string' || content.length < 16) return false;
    const first = content.charCodeAt(0);
    if (first >= 0x2800 && first <= 0x28ff) return true;
    return content.startsWith('```') && content.includes('-----SYSTEM MESSAGE-----');
  }
  function isLegacyEmbed(message) {
    const embeds = message.embeds;
    if (!Array.isArray(embeds) || embeds.length !== 1) return false;
    return legacyFooterNames.includes(embeds[0]?.footer?.text);
  }
  function messageNeedsProcessing(message) {
    if (isCandidateContent(message.content) || isLegacyEmbed(message)) return true;
    const ref = message.referenced_message;
    if (ref != null && typeof ref === 'object' && (isCandidateContent(ref.content) || isLegacyEmbed(ref)))
      return true;
    const snapshots = message.message_snapshots;
    if (Array.isArray(snapshots))
      for (const snapshot of snapshots) if (isCandidateContent(snapshot?.message?.content)) return true;
    return false;
  }

  function collectMessages(event) {
    const found = [];
    const seen = new Set();
    let budget = 20000;
    const walk = (node, depth) => {
      if (node == null || typeof node !== 'object' || depth > 6 || --budget < 0 || seen.has(node))
        return;
      seen.add(node);
      if (Array.isArray(node)) {
        for (let i = 0; i < node.length; i++) walk(node[i], depth + 1);
        return;
      }
      if (typeof node.content === 'string' && node.channel_id != null && node.id != null) {
        found.push(node);
        return;
      }
      for (const key in node) {
        if (key === 'author' || key === 'member' || key === 'mentions' || key === 'reactions' || key === 'embeds')
          continue;
        let value;
        try {
          value = node[key];
        } catch (e) {
          continue;
        }
        if (value != null && typeof value === 'object') walk(value, depth + 1);
      }
    };
    walk(event, 0);
    return found;
  }

  function applyPingOn(message) {
    if (Cache.pingOn == null || typeof message.content !== 'string') return;
    try {
      Cache.pingOn.lastIndex = 0;
      if (Cache.pingOn.test(message.content)) {
        const currentUser = Discord.getCurrentUser();
        if (currentUser != null) message.mentions = [currentUser];
      }
    } catch (e) {}
  }

  const withTimeout = (promise, ms) =>
    Promise.race([promise, new Promise((resolve) => setTimeout(() => resolve(false), ms))]);

  var dispatchChain = Promise.resolve();
  var pendingDispatches = 0;
  function HandleDispatch(event) {
    const type = event?.type;
    const special = eventHandlers[type];
    if (special !== undefined) return special.apply(this, arguments);

    if (typeof type !== 'string' || !WalkEventRegex.test(type) || SkipWalkEventRegex.test(type))
      return Discord.original_dispatch.apply(this, arguments);

    let candidates = [];
    // also collect while the database is being unlocked; they are processed once it is
    if (Active || dbGateResolve != null) {
      const messages = collectMessages(event);
      for (const message of messages) {
        if (messageNeedsProcessing(message)) candidates.push(message);
        else if (type === 'MESSAGE_CREATE') applyPingOn(message);
      }
    }
    // Keep message events in order: once something is waiting, everything queues behind it
    if (candidates.length === 0 && pendingDispatches === 0)
      return Discord.original_dispatch.apply(this, arguments);

    const self = this;
    const args = arguments;
    pendingDispatches++;
    const run = async () => {
      try {
        if (!Active) candidates = [];
        let swallow = false;
        const ctx = { waitedKeys: new Set() };
        for (const message of candidates) {
          try {
            const deleted = await withTimeout(processMessage(message, false, ctx), 10000);
            if (deleted && type === 'MESSAGE_CREATE' && message === event.message) swallow = true;
          } catch (e) {
            Utils.Error('failed to process a message', e);
          }
        }
        if (!swallow) return await Discord.original_dispatch.apply(self, args);
      } finally {
        pendingDispatches--;
      }
    };
    const result = dispatchChain.then(run, run);
    dispatchChain = result.catch(() => {});
    return result;
  }

  // Run once on load so the queue gate can hold messages while the DB is being unlocked
  var dbGateResolve = null;
  function LockMessages() {
    Active = false;
    pendingDispatches++;
    dispatchChain = new Promise((resolve) => {
      dbGateResolve = resolve;
    }).finally(() => {
      pendingDispatches--;
    });
    Discord.detour_dispatch = HandleDispatch;
  }
  function UnlockMessages(loaded) {
    Active = !!loaded;
    if (!loaded) {
      for (const alias of Discord.hookedAliases || [])
        if (alias !== 'dispatch') Discord[`detour_${alias}`] = Discord[`original_${alias}`];
    }
    if (dbGateResolve != null) {
      dbGateResolve();
      dbGateResolve = null;
    }
  }

  async function processMessage(message, ignoreAttachments, ctx, owner, isSnapshot) {
    if (message == null || typeof message !== 'object') return false;
    owner = owner || message;
    ctx = ctx || { waitedKeys: new Set() };

    const ref = message.referenced_message;
    if (ref != null && typeof ref === 'object' && !isSnapshot && messageNeedsProcessing(ref))
      await processMessage(ref, true, ctx, ref);

    if (Array.isArray(message.message_snapshots)) {
      for (const snapshot of message.message_snapshots) {
        const snapshotMessage = snapshot?.message;
        if (snapshotMessage == null || !isCandidateContent(snapshotMessage.content)) continue;
        if (snapshotMessage.channel_id == null) snapshotMessage.channel_id = message.channel_id;
        await processMessage(snapshotMessage, false, ctx, owner, true);
      }
    }

    let result = false;
    const content = message.content;
    if (typeof content === 'string') {
      const messageMatch = messageRegex.exec(content);
      if (messageMatch != null) {
        result = await decryptMessage(message, messageMatch[1], ignoreAttachments, ctx, owner);
      } else if (!isSnapshot) {
        const systemMessageMatch = systemMessageRegex.exec(content);
        if (systemMessageMatch != null) processUpdateSystemMessage(message, systemMessageMatch[1]);
        else result = await processEmbeds(message, ignoreAttachments, ctx, owner);
      }
    }

    if (!isSnapshot) applyPingOn(message);

    return !!result;
  }

  // extension -> [kind, mime type]
  const mediaTypes = {
    png: ['image', 'image/png'],
    apng: ['image', 'image/apng'],
    jpg: ['image', 'image/jpeg'],
    jpeg: ['image', 'image/jpeg'],
    jpe: ['image', 'image/jpeg'],
    jfif: ['image', 'image/jpeg'],
    gif: ['image', 'image/gif'],
    webp: ['image', 'image/webp'],
    avif: ['image', 'image/avif'],
    bmp: ['image', 'image/bmp'],
    mp4: ['video', 'video/mp4'],
    m4v: ['video', 'video/mp4'],
    mov: ['video', 'video/mp4'], // most .mov files are H.264 and play when labelled mp4
    webm: ['video', 'video/webm'],
    mkv: ['video', 'video/webm'],
    ogv: ['video', 'video/ogg'],
    mp3: ['audio', 'audio/mpeg'],
    wav: ['audio', 'audio/wav'],
    ogg: ['audio', 'audio/ogg'],
    oga: ['audio', 'audio/ogg'],
    opus: ['audio', 'audio/ogg'],
    m4a: ['audio', 'audio/mp4'],
    aac: ['audio', 'audio/aac'],
    flac: ['audio', 'audio/flac'],
    weba: ['audio', 'audio/webm'],
  };
  const extensionRegex = /\.([^.]+)$/;
  const TransparentGif =
    'data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==';

  // Encrypted files get links with #e2ee=<token>, intercepted by our click handler
  const DownloadRegistry = new Map();
  const BlobRegistry = new Map(); // blob url (without hash) -> filename
  const VideoRegistry = new Map(); // poster blob url (without hash) -> { src, filename }
  let downloadTokenCounter = 0;
  function registerDownload(filename, keyHash, url) {
    const token = (++downloadTokenCounter).toString(36) + Utils.BytesToBase64url(Utils.GetRandomBytes(6));
    DownloadRegistry.set(token, { filename, keyHash, url });
    return token;
  }
  async function decryptAndDownload(token) {
    const entry = DownloadRegistry.get(token);
    if (entry == null) return;
    try {
      const encryptedFileBuffer = await Utils.DownloadFile(entry.url);
      const fileBuffer = await Utils.AesDecrypt(await Utils.GetKeyByHash(entry.keyHash), encryptedFileBuffer);
      Utils.DownloadBlob(entry.filename, new File([fileBuffer], entry.filename));
    } catch (e) {
      Utils.Error('file download failed', e);
      PopupManager.Notice(`Couldn't download or decrypt "${entry.filename}". ${e?.message ?? ''}`);
    }
  }

  const loadMedia = (element, url, readyEvent) =>
    withTimeoutReject(
      new Promise((resolve, reject) => {
        element.addEventListener(readyEvent, resolve, { once: true });
        element.addEventListener('error', () => reject(new Error('unsupported media')), { once: true });
        element.src = url;
      }),
      20000
    );

  async function makeVideoPoster(video, spoiler) {
    const width = video.videoWidth || 640;
    const height = video.videoHeight || 360;
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, width, height);
    try {
      video.currentTime = Math.min(0.5, (video.duration || 1) / 4);
      await withTimeoutReject(new Promise((resolve) => video.addEventListener('seeked', resolve, { once: true })), 5000);
      if (spoiler) ctx.filter = 'blur(40px)';
      ctx.drawImage(video, 0, 0, width, height);
    } catch (e) {}
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.85));
    return { url: URL.createObjectURL(blob), width, height };
  }

  var downloadLocked = false;
  var downloadLocks = [];
  async function decryptAttachment(key, keyHash, message, attachment, channelConfig, owner) {
    let filename;
    try {
      filename = await Utils.AesDecryptString(key, Utils.Base64urlToBytes(attachment.filename));
    } catch (e) {
      filename = 'file';
    }
    filename = filename.replace(/[\\/\u0000-\u001f]/g, '_') || 'file';

    attachment.filename = filename;
    for (const field of ['content_type', 'width', 'height', 'placeholder', 'placeholder_version', 'duration_secs', 'waveform', 'flags'])
      delete attachment[field];
    const encryptedUrl = attachment.url;

    const match = extensionRegex.exec(filename);
    const [mediaKind, mimeType] = (match != null && mediaTypes[match[1].toLowerCase()]) || [];

    const addAsDownload = () => {
      const token = registerDownload(filename, keyHash, encryptedUrl);
      attachment.url = `${String(encryptedUrl).split('#')[0]}#e2ee=${token}`;
      attachment.proxy_url = attachment.url;
      if (!message.attachments.includes(attachment)) message.attachments.push(attachment);
    };
    if (mediaKind == null) {
      addAsDownload();
      return;
    }

    const spoiler = filename.startsWith('SPOILER_');
    // keeps the space while the file downloads, so the chat doesn't jump
    const placeholder =
      mediaKind === 'audio'
        ? null
        : { type: 'image', thumbnail: { url: TransparentGif, width: 400, height: mediaKind === 'video' ? 225 : 300 } };
    if (placeholder != null) message.embeds.push(placeholder);

    const downloadAndProcess = async () => {
      if (downloadLocked) {
        await new Promise((resolve) => downloadLocks.push([message.channel_id, resolve]));
      } else downloadLocked = true;

      const removePlaceholder = () => {
        const index = message.embeds.indexOf(placeholder);
        if (index !== -1) message.embeds.splice(index, 1);
      };
      const fallBackToDownload = () => {
        removePlaceholder();
        addAsDownload();
        Discord.dispatch({ type: 'MESSAGE_UPDATE', message: owner });
      };

      let encryptedFileBuffer;
      try {
        encryptedFileBuffer = await Utils.DownloadFile(encryptedUrl);
      } catch (e) {
        Utils.Error('file download failed', e);
        fallBackToDownload();
        return;
      } finally {
        if (downloadLocks.length !== 0) {
          let importantDlIndex = downloadLocks.findIndex(([channelId]) => channelId === Cache.channelId);
          let unlockNext =
            importantDlIndex > 0
              ? downloadLocks.splice(importantDlIndex, 1)[0][1]
              : downloadLocks.shift()[1];
          unlockNext();
        } else downloadLocked = false;
      }

      let fileBuffer;
      try {
        fileBuffer = await Utils.AesDecrypt(await Utils.GetKeyByHash(keyHash), encryptedFileBuffer);
      } catch (e) {
        Utils.Error('file decryption failed', e);
        fallBackToDownload();
        return;
      }
      const file = new File([fileBuffer], filename, { type: mimeType });
      const rawBlobUrl = URL.createObjectURL(file);
      BlobRegistry.set(rawBlobUrl, filename);
      // the hash keeps the URL valid when Discord appends ?width=… to it
      const blobUrl = `${rawBlobUrl}#${encodeURIComponent(filename)}`;

      try {
        if (mediaKind === 'image') {
          // shown by Discord itself as a normal image attachment (zoom, viewer, spoilers…)
          const img = document.createElement('img');
          await loadMedia(img, blobUrl, 'load');
          removePlaceholder();
          Object.assign(attachment, {
            url: blobUrl,
            proxy_url: blobUrl,
            content_type: mimeType,
            size: file.size,
            width: img.naturalWidth,
            height: img.naturalHeight,
          });
          message.attachments.push(attachment);
        } else if (mediaKind === 'audio') {
          // shown by Discord's own audio player
          const audio = document.createElement('audio');
          audio.preload = 'metadata';
          await loadMedia(audio, blobUrl, 'loadedmetadata');
          Object.assign(attachment, {
            url: blobUrl,
            proxy_url: blobUrl,
            content_type: mimeType,
            size: file.size,
          });
          if (Number.isFinite(audio.duration)) attachment.duration_secs = audio.duration;
          message.attachments.push(attachment);
        } else {
          // Discord's video player refuses local files, so show a poster and play it with our own player
          const video = document.createElement('video');
          video.muted = true;
          video.preload = 'auto';
          await loadMedia(video, blobUrl, 'loadeddata');
          const poster = await makeVideoPoster(video, spoiler);
          video.removeAttribute('src');
          VideoRegistry.set(poster.url, { src: blobUrl, filename });
          BlobRegistry.set(poster.url, filename);
          const posterUrl = `${poster.url}#${encodeURIComponent(filename)}`;
          for (const k of Object.keys(placeholder)) delete placeholder[k];
          Object.assign(placeholder, {
            type: 'image',
            url: posterUrl,
            thumbnail: { url: posterUrl, proxy_url: posterUrl, width: poster.width, height: poster.height },
          });
        }
      } catch (e) {
        // unsupported codec or broken file: offer it as a normal download instead
        Utils.Warn(`can't preview "${filename}" (${e?.message ?? e}), showing it as a download`);
        fallBackToDownload();
        return;
      }

      Discord.dispatch({ type: 'MESSAGE_UPDATE', message: owner });
    };
    if (
      message.channel_id === Cache.channelId ||
      (channelConfig != null && channelConfig.l /*lastseen*/ > Date.now() - InactiveChannelTime)
    )
      downloadAndProcess();
    else {
      let onChannelOpen = () => {
        downloadAndProcess();
        Utils.RemoveChannelSelectListener(message.channel_id, onChannelOpen);
      };
      Utils.AddChannelSelectListener(message.channel_id, onChannelOpen);
    }
  }

  // Adds a play button over decrypted video posters and swaps in a real player on click
  const PlayIconSvg = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5.5v13a1 1 0 0 0 1.5.86l10.5-6.5a1 1 0 0 0 0-1.72L9.5 4.64A1 1 0 0 0 8 5.5Z"/></svg>`;
  const VideoPatcher = {
    Start: function () {
      this.observer = new MutationObserver(() => this.Schedule());
      this.observer.observe(document.body, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['src'],
      });
      this.Schedule();
    },
    Schedule: function () {
      if (this.timeout != null || VideoRegistry.size === 0) return;
      this.timeout = setTimeout(() => {
        this.timeout = null;
        this.Scan();
      }, 150);
    },
    Scan: function () {
      for (const img of document.querySelectorAll('img[src^="blob:"]')) {
        const info = VideoRegistry.get(img.getAttribute('src').split(/[#?]/)[0]);
        if (info == null) continue;
        const container = img.closest('[class*="imageWrapper"]') || img.parentElement;
        if (container == null || container.querySelector(':scope > .e2ee-video-overlay, :scope > .e2ee-video') != null)
          continue;
        if (getComputedStyle(container).position === 'static') container.style.position = 'relative';

        const overlay = document.createElement('div');
        overlay.className = 'e2ee-video-overlay';
        overlay.title = `Play ${info.filename}`;
        overlay.innerHTML = `<div class="e2ee-play">${PlayIconSvg}</div><div class="e2ee-video-name"></div>`;
        overlay.lastChild.textContent = info.filename;
        const stop = (e) => e.stopPropagation();
        overlay.addEventListener('mousedown', stop);
        overlay.addEventListener('pointerdown', stop);
        overlay.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          const video = document.createElement('video');
          video.className = 'e2ee-video';
          video.controls = true;
          video.autoplay = true;
          video.playsInline = true;
          video.src = info.src;
          for (const type of ['click', 'mousedown', 'pointerdown', 'dblclick', 'keydown'])
            video.addEventListener(type, stop);
          overlay.replaceWith(video);
        });
        container.appendChild(overlay);
      }
    },
    Stop: function () {
      if (this.observer) this.observer.disconnect();
      clearTimeout(this.timeout);
      this.timeout = null;
      for (const element of document.querySelectorAll('.e2ee-video-overlay, .e2ee-video')) element.remove();
    },
  };
  const withTimeoutReject = (promise, ms) =>
    Promise.race([
      promise,
      new Promise((resolve, reject) => setTimeout(() => reject(new Error('timeout')), ms)),
    ]);

  const starttimeRegex = /(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?/;
  function createYoutubeEmbed(id, timequery) {
    let embedUrl = `https://www.youtube.com/embed/${id}`;
    if (timequery != null) {
      let time = timequery.split('=')[1];
      let timeMatch = starttimeRegex.exec(time);
      let t = 0;
      if (timeMatch[1] !== undefined) t += timeMatch[1] * 3600;
      if (timeMatch[2] !== undefined) t += timeMatch[2] * 60;
      if (timeMatch[3] !== undefined) t += parseInt(timeMatch[3]);
      if (t !== 0) time = t;
      embedUrl += '?start=' + time;
    }
    return {
      type: 'video',
      url: `https://www.youtube.com/watch?v=${id}`,
      thumbnail: { url: `https://i.ytimg.com/vi/${id}/maxresdefault.jpg`, width: 1280, height: 720 },
      video: { url: embedUrl, width: 1280, height: 720 },
    };
  }
  const youtubeRegex = /[?&]v=([\w-]+).*?(&(?:t|start)=[\dhms]+)?/;
  function embedYoutube(message, url, queryString) {
    let match = youtubeRegex.exec(queryString);
    if (match != null) message.embeds.push(createYoutubeEmbed(match[1], match[2]));
  }
  const youtuRegex = /^([\w-]+).*?(\?(?:t|start)=[\dhms]+)?/;
  function embedYoutu(message, url, queryString) {
    let match = youtuRegex.exec(queryString);
    if (match != null) message.embeds.push(createYoutubeEmbed(match[1], match[2]));
  }
  const imageRegex = /^[^?]*\.(?:png|jpe?g|gif|webp|avif)(?:$|\?)/i;
  function embedImage(message, url, queryString) {
    if (!imageRegex.test(queryString)) return;

    let placeholder = {
      type: 'image',
      url,
      thumbnail: { url: TransparentGif, width: 1, height: 300 },
    };
    message.embeds.push(placeholder);
    let tmpimg = document.createElement('img');
    tmpimg.onload = () => {
      placeholder.thumbnail = { url, width: tmpimg.naturalWidth, height: tmpimg.naturalHeight };
      Discord.dispatch({ type: 'MESSAGE_UPDATE', message });
    };
    tmpimg.src = url;
  }
  // only hosts allowed by Discord's content security policy
  const linkEmbedders = {
    'www.youtube.com': embedYoutube,
    'youtube.com': embedYoutube,
    'm.youtube.com': embedYoutube,
    'youtu.be': embedYoutu,
    'cdn.discordapp.com': embedImage,
    'media.discordapp.net': embedImage,
    'i.imgur.com': embedImage,
  };

  const MENTION_EVERYONE_CHECK = 0x20000n;
  const everyoneRegex = /(?<!https?:\/\/[^\s]*)@(?:everyone|here)/;
  const roleMentionRegex = /<@&(\d{16,20})>/g;
  const urlRegex =
    /(?:<https?:\/\/(?:[^\s\/?\.#]+\.)+(?:[^\s\/?\.#]+)\/[^\s<>'"]+>|https?:\/\/((?:[^\s\/?\.#]+\.)+(?:[^\s\/?\.#]+))\/([^\s<>'"]+))/g;
  function isRoleMentionable(guildId, roleId) {
    const guild = Discord.getGuild(guildId);
    const role =
      guild?.roles?.[roleId] ??
      Discord.modules.GuildRoleStore?.getRole?.(guildId, roleId) ??
      Discord.modules.GuildRoleStore?.getRoles?.(guildId)?.[roleId];
    return !!role?.mentionable;
  }
  function postProcessMessage(message, content) {
    let currentUser = Discord.getCurrentUser();
    if (
      currentUser != null &&
      (content.includes(`<@${currentUser.id}>`) || content.includes(`<@!${currentUser.id}>`))
    ) {
      message.mentions = [currentUser];
    } else if (message.author != null) {
      let guildId = message.guild_id;
      let channel;
      if (guildId == null) {
        channel = Discord.getChannel(message.channel_id);
        guildId = channel?.guild_id;
      }
      if (guildId != null) {
        let canMentionEveryone;
        if (everyoneRegex.test(content)) {
          if (channel == null) channel = Discord.getChannel(message.channel_id);
          message.mention_everyone = canMentionEveryone = Utils.Can(
            MENTION_EVERYONE_CHECK,
            message.author,
            channel
          );
        }

        let mentionRoles = [...content.matchAll(roleMentionRegex)].map((x) => x[1]);
        if (mentionRoles.length !== 0) {
          if (canMentionEveryone == null) {
            if (channel == null) channel = Discord.getChannel(message.channel_id);
            canMentionEveryone = Utils.Can(MENTION_EVERYONE_CHECK, message.author, channel);
          }
          if (!canMentionEveryone)
            mentionRoles = mentionRoles.filter((x) => isRoleMentionable(guildId, x));
          message.mention_roles = mentionRoles;
        }
      }
    }

    let url;
    while ((url = urlRegex.exec(content)) != null) {
      if (url[1] == null) continue;
      let linkEmbedder = linkEmbedders[url[1]];
      if (linkEmbedder != null) linkEmbedder(message, url[0], url[2]);
    }
    urlRegex.lastIndex = 0;
  }

  let keywaitingMessages = {};
  async function decryptWaitingMessages(keyHash) {
    let waitingMessages = keywaitingMessages[keyHash];
    if (waitingMessages == null) return;
    delete keywaitingMessages[keyHash];
    for (let [message, payload, originalRef, owner] of waitingMessages) {
      decryptMessage(Object.assign(originalRef, message), payload, false, null, owner)
        .then(() => Utils.UpdateMessageContent(owner))
        .catch((e) => Utils.Error(e));
    }
  }

  let keyChangeWatchers = {};
  async function decryptMessage(message, payload, ignoreAttachments, ctx, owner) {
    owner = owner || message;
    ctx = ctx || { waitedKeys: new Set() };
    if (!Array.isArray(message.embeds)) message.embeds = [];

    let payloadBuffer = Utils.PayloadDecode(payload).buffer;
    let keyHashBytes = payloadBuffer.slice(0, 16);
    let keyHashBase64 = Utils.BytesToBase64(keyHashBytes);
    let keyObjRef = [];
    let key = await Utils.GetKeyByHash(keyHashBase64, keyObjRef);

    if (key == null) {
      let messageDeleted = false;
      if (!DataBase.isSecondary && message.author != null && message.id != null) {
        let keyExchange = Utils.InitKeyExchangeAndRequestKey(keyHashBase64, message.author, message.id);

        // only the first message per batch waits for the exchange, the rest are queued
        if (!ctx.waitedKeys.has(keyHashBase64)) {
          ctx.waitedKeys.add(keyHashBase64);
          let onMessageDelete;
          let messageDeleteException = new Promise((resolve) => {
            onMessageDelete = () => {
              messageDeleted = true;
              resolve();
            };
            Utils.AddMessageDeleteListener(message.id, onMessageDelete);
          });

          for (let i = 1; i <= 5; i++) {
            await Promise.race([keyExchange, Utils.Sleep(i * 200), messageDeleteException]);
            if (messageDeleted) break;

            key = await Utils.GetKeyByHash(keyHashBase64, keyObjRef);
            if (key != null) break;
          }
          Utils.RemoveMessageDeleteListener(message.id, onMessageDelete);
        }
      }
      if (key == null) {
        if (!messageDeleted) {
          let waitingMessages = keywaitingMessages[keyHashBase64];
          if (waitingMessages == null) keywaitingMessages[keyHashBase64] = waitingMessages = [];
          waitingMessages.push([Object.assign({}, message), payload, message, owner]);
        }
        message.content = unknownKeyMessage;
        message.embeds = [];
        message.attachments = [];
        return messageDeleted;
      }
    }

    let channelId = message.channel_id;
    let channelConfig =
      channelId === Cache.channelId ? Cache.channelConfig : DataBase.channels[channelId]; //don't bump lastseen
    let keyObj = keyObjRef[0] || DataBase.keys[keyHashBase64];
    let myKey;
    let differentKey = false;
    let differentKeyDescriptor;
    let differentKeyDesc;
    let notPersonalKey = keyObj.t /*type*/ !== 3; /*personal*/
    if (channelConfig == null) {
      differentKey = notPersonalKey;
    } else if (keyHashBase64 !== channelConfig.k /*key*/) {
      if (notPersonalKey) differentKey = true;
      else {
        myKey = DataBase.keys[channelConfig.k];
        if (myKey == null || myKey.t /*type*/ !== 3 /*personal*/) differentKey = true;
      }
    }
    if (differentKey) {
      differentKeyDescriptor = Utils.FormatDescriptor(keyObj.d /*descriptor*/);
      differentKeyDesc = differentKeyDescriptor.replace(/ /g, '_').replace(/\W/g, '').slice(0, 30);
    }
    let timestamp = new Date(message.timestamp).getTime();
    if (differentKey && notPersonalKey && channelConfig != null && message.id != null) {
      if (timestamp > Date.now() - IgnoreDiffKeyAge) {
        let keyChangeWatcher = keyChangeWatchers[channelId];
        if (keyChangeWatcher == null) keyChangeWatchers[channelId] = { different: 1, sameKeyTime: 0 };
        else if (
          timestamp > keyChangeWatcher.sameKeyTime &&
          ++keyChangeWatcher.different === DiffKeyTrigger &&
          KeyRotators[channelConfig.k] == null
        ) {
          if (myKey == null) myKey = DataBase.keys[channelConfig.k];
          if (myKey?.t /*type*/ !== 2 /*conversation*/)
            (async () => {
              let popupOverride = {};
              let popup = PopupManager.NewPromise(
                `People here are using the key "${differentKeyDescriptor}". Switch "${Utils.FormatDescriptor(
                  channelConfig.d
                )}" to it?`,
                true,
                popupOverride
              );
              const autoCancel = () => {
                keyChangeWatcher.different = 0;
                popupOverride.cancel();
              };
              Utils.AddMessageDeleteListener(message.id, autoCancel);
              let changeKey = await popup;
              Utils.RemoveMessageDeleteListener(message.id, autoCancel);
              if (changeKey) {
                if (channelId === Cache.channelId) {
                  await Utils.SetCurrentChannelKey(keyHashBase64);
                  MenuBar.Update();
                } else Utils.SetChannelKey(channelId, keyHashBase64);
              }
            })();
        }
      }
    } else if (timestamp > Date.now() - IgnoreDiffKeyAge) {
      let keyChangeWatcher = keyChangeWatchers[channelId];
      if (keyChangeWatcher == null) keyChangeWatchers[channelId] = { different: 0, sameKeyTime: timestamp };
      else if (keyChangeWatcher.sameKeyTime < timestamp) {
        keyChangeWatcher.different = 0;
        keyChangeWatcher.sameKeyTime = timestamp;
      }
    }

    message.embeds = []; //remove embeds in case of edit and in case of the payload is from the embed

    const marker = differentKey
      ? `<:ENC_${differentKeyDesc}:${EncOtherKeyEmojiId}>`
      : `<:ENC:${EncEmojiId}>`;
    if (payloadBuffer.byteLength === 16) {
      message.content = marker + '⁣'; //invisible separator at the end to make the emoji smaller
    } else {
      let content;
      try {
        content = await Utils.AesDecryptDecompressString(key, payloadBuffer.slice(16));
      } catch (e) {
        message.content = invalidMessage;
        message.attachments = [];
        return false;
      }
      message.content = marker + content;
      postProcessMessage(message, content);
    }

    if (Array.isArray(message.attachments) && message.attachments.length !== 0 && !ignoreAttachments) {
      let attachments = message.attachments;
      message.attachments = [];
      for (let attachment of attachments) {
        try {
          await decryptAttachment(key, keyHashBase64, message, attachment, channelConfig, owner);
        } catch (e) {
          attachment.filename = 'encrypted file (failed to decrypt)';
          message.attachments.push(attachment);
        }
      }
    }
    return false;
  }

  function getSystemMessageProperty(propertyName, sysmsg) {
    let match = new RegExp(`\\*${propertyName}\\*:\\s*\`(.*?)\``, 'i').exec(sysmsg);
    return match == null ? null : match[1];
  }

  var keyExchangeWhitelist = {};
  async function processSystemMessage(message, sysmsg) {
    let channel = Discord.getChannel(message.channel_id);
    if (channel == null || channel.type !== 1 /*DM*/) return false;

    message.embeds = [];
    let timestamp = new Date(message.timestamp).getTime();
    let channelConfig = Utils.GetOrCreateChannelConfig(message.channel_id);
    let oldMessage = true;
    if (channelConfig.s /*systemMessageTime*/ == null || timestamp > channelConfig.s) {
      channelConfig.s = timestamp;
      Utils.dbChanged = true;
      oldMessage = false;
    }

    let messageType = getSystemMessageProperty('type', sysmsg);
    let userId;
    if (message.author == null) oldMessage = true;
    else {
      userId = message.author.id;
      if (userId === Discord.getCurrentUser()?.id) oldMessage = true;
    }

    if (
      DataBase.isSecondary &&
      !keyExchangeWhitelist[userId] &&
      (messageType !== 'KEY SHARE' ||
        DataBase.trustedKeys == null ||
        !DataBase.trustedKeys[channelConfig.k])
    )
      oldMessage = true; //secondary devices only accept shares over trusted keys

    let nonForced = true;
    if (!oldMessage) {
      message.content = blockedSystemMessage;
      if (Utils.NeedsKeyExchangeConsent(userId)) {
        if (
          messageType === 'DH KEY' ||
          messageType === 'DH RESPONSE' ||
          messageType === 'PERSONAL KEY' ||
          messageType === 'KEY SHARE'
        ) {
          if (!keyExchangeWhitelist[userId]) {
            if (
              !(await PopupManager.NewPromise(
                `Accept a key exchange from ${Utils.UserTag(message.author)}?`,
                true
              ))
            )
              return false;
            keyExchangeWhitelist[userId] = true;
          }
        }
      } else nonForced = false;
    }

    switch (messageType) {
      case 'DH KEY':
        {
          message.content = '-# 🔑 Started a secure key exchange';
          if (oldMessage) return false;

          let dhKeyPayload = getSystemMessageProperty('dhKey', sysmsg);
          if (dhKeyPayload == null) break;
          try {
            let dhRemoteKey = await Utils.DhImportPublicKey(Utils.PayloadDecode(dhKeyPayload));
            let dhPrivateKey = await Utils.ReadDhKey();
            let sharedSecret = await Utils.DhGetSecret(dhPrivateKey, dhRemoteKey);
            let keyHash = await Utils.SaveKey(
              sharedSecret,
              2 /*conversation*/,
              `DM key with <@${message.author.id}>`
            );
            Utils.KeyShareEvent(keyHash);
            channelConfig.k /*keyHash*/ = keyHash;
            if (message.channel_id === Cache.channelId) {
              Cache.channelConfig = channelConfig; //in case it's a new config
              MenuBar.Update();
            }

            let dhPublicKeyPayload = Utils.PayloadEncode(Utils.Base64ToBytes(DataBase.dhPublicKey));
            let key = await Utils.AesImportKey(sharedSecret);
            let encryptedPersonalKey = await Utils.AesEncrypt(
              key,
              await Utils.GetKeyBytesByHash(DataBase.personalKeyHash)
            );
            let personalKeyPayload = Utils.PayloadEncode(encryptedPersonalKey);

            Utils.SendSystemMessage(
              message.channel_id,
              `*type*: \`DH RESPONSE\`\n*dhKey*: \`${dhPublicKeyPayload}\`\n*personalKey*: \`${personalKeyPayload}\``
            );

            channelConfig.w = 1; //waitingForSystemMessage
            Utils.FastSaveDb();
            decryptWaitingMessages(keyHash);
          } catch (e) {
            break;
          }
        }
        return true;
      case 'DH RESPONSE':
        {
          message.content = '-# 🔑 Accepted the key exchange';
          if (oldMessage) return false;

          let dhKeyPayload = getSystemMessageProperty('dhKey', sysmsg);
          if (dhKeyPayload == null) break;
          let remotePersonalKeyPayload = getSystemMessageProperty('personalKey', sysmsg);
          if (remotePersonalKeyPayload == null) break;
          try {
            let dhRemoteKey = await Utils.DhImportPublicKey(Utils.PayloadDecode(dhKeyPayload));
            let dhPrivateKey = await Utils.ReadDhKey();
            let sharedSecret = await Utils.DhGetSecret(dhPrivateKey, dhRemoteKey);
            let keyHash = await Utils.SaveKey(
              sharedSecret,
              2 /*conversation*/,
              `DM key with <@${message.author.id}>`
            );
            Utils.KeyShareEvent(keyHash);
            channelConfig.k /*keyHash*/ = keyHash;
            Utils.FastSaveDb();
            if (message.channel_id === Cache.channelId) {
              Cache.channelConfig = channelConfig;
              MenuBar.Update();
            }

            let key = await Utils.AesImportKey(sharedSecret);
            let remotePersonalKey = await Utils.AesDecrypt(
              key,
              Utils.PayloadDecode(remotePersonalKeyPayload)
            );
            if (remotePersonalKey.byteLength !== 32) break;
            let remotePersonalKeyHash = await Utils.SaveKey(
              remotePersonalKey,
              3 /*personal*/,
              `<@${message.author.id}>'s personal key`
            );
            Utils.KeyShareEvent(remotePersonalKeyHash);

            await Utils.SendPersonalKey(message.channel_id);

            Utils.KeyExchangeEvent(userId);

            decryptWaitingMessages(keyHash);
            decryptWaitingMessages(remotePersonalKeyHash);
          } catch (e) {
            break;
          }
        }
        return true;
      case 'PERSONAL KEY':
        {
          message.content = '-# 🔑 Shared their personal key — this DM is now end-to-end encrypted';
          if (oldMessage) return false;

          let keyHashPayload = getSystemMessageProperty('key', sysmsg);
          if (keyHashPayload == null) break;
          let remotePersonalKeyPayload = getSystemMessageProperty('personalKey', sysmsg);
          if (remotePersonalKeyPayload == null) break;
          try {
            let keyHash = Utils.BytesToBase64(Utils.PayloadDecode(keyHashPayload));
            let key = await Utils.GetKeyByHash(keyHash);
            if (key == null) {
              message.content = unknownKeySystemMessage;
              return true;
            }

            let remotePersonalKey = await Utils.AesDecrypt(
              key,
              Utils.PayloadDecode(remotePersonalKeyPayload)
            );
            if (remotePersonalKey.byteLength !== 32) break;
            let remotePersonalKeyHash = await Utils.SaveKey(
              remotePersonalKey,
              3 /*personal*/,
              `<@${message.author.id}>'s personal key`
            );
            Utils.KeyShareEvent(remotePersonalKeyHash);

            delete channelConfig.w; //waitingForSystemMessage
            Utils.FastSaveDb();
            delete keyExchangeWhitelist[userId];

            Utils.KeyExchangeEvent(userId);

            decryptWaitingMessages(remotePersonalKeyHash);
          } catch (e) {
            break;
          }
        }
        return true;
      case 'KEY REQUEST':
        {
          message.content = '-# 🔑 Asked for a key';
          if (oldMessage) return false;

          let requestedKeyPayload = getSystemMessageProperty('requestedKey', sysmsg);
          if (requestedKeyPayload == null) break;
          try {
            let keyHash = Utils.BytesToBase64(Utils.PayloadDecode(requestedKeyPayload));
            Utils.ShareKey(keyHash, message.channel_id, nonForced, message.author); //no need to wait
          } catch (e) {
            break;
          }
        }
        return true;
      case 'KEY SHARE':
        {
          let status = getSystemMessageProperty('status', sysmsg);
          const statusMsgs = {
            OK: '-# 🔑 Shared a key',
            DENIED: '-# 🔑 Declined to share a key',
            'NOT FOUND': "-# 🔑 Couldn't find the requested key",
          };
          let statusMsg = statusMsgs[status];
          if (statusMsg == null) break;
          message.content = statusMsg;
          if (oldMessage || status !== 'OK') return false;

          let keyHashPayload = getSystemMessageProperty('key', sysmsg);
          if (keyHashPayload == null) break;
          let sharedKeyPayload = getSystemMessageProperty('sharedKey', sysmsg);
          if (sharedKeyPayload == null) break;
          let keyTypeName = getSystemMessageProperty('keyType', sysmsg);
          if (keyTypeName == null) break;
          let keyDescriptor = getSystemMessageProperty('keyDescriptor', sysmsg);
          if (keyDescriptor == null) break;
          try {
            let keyHash = Utils.BytesToBase64(Utils.PayloadDecode(keyHashPayload));
            let key = await Utils.GetKeyByHash(keyHash);
            if (key == null) {
              message.content = unknownKeySystemMessage;
              return true;
            }

            let sharedKey = await Utils.AesDecrypt(key, Utils.PayloadDecode(sharedKeyPayload));
            if (sharedKey.byteLength !== 32) break;
            const keyTypeNames = { GROUP: 1, CONVERSATION: 2, PERSONAL: 3 };
            let keyType = keyTypeNames[keyTypeName];
            if (keyType == null) break;

            if (keyType !== 1 /*group*/) keyDescriptor += ` by <@${userId}>`;

            let keyHidden = getSystemMessageProperty('keyHidden', sysmsg) === 'YES';

            let sharedKeyHash = await Utils.SaveKey(sharedKey, keyType, keyDescriptor, keyHidden);
            Utils.KeyShareEvent(sharedKeyHash);

            delete channelConfig.w; //waitingForSystemMessage
            Utils.FastSaveDb();
            delete keyExchangeWhitelist[userId];

            if (keyType === 1 /*group*/) {
              let sharedChannelsJson = getSystemMessageProperty('sharedChannels', sysmsg);
              if (sharedChannelsJson != null) {
                let trustedKey = DataBase.trustedKeys != null && DataBase.trustedKeys[keyHash];
                let sharedChannels = JSON.parse(sharedChannelsJson);
                if (!Array.isArray(sharedChannels)) sharedChannels = [];
                for (let channelId of sharedChannels.slice(0, 20)) {
                  if (!/^\d{1,20}$/.test(String(channelId))) continue;
                  let existingConfig = DataBase.channels[channelId];
                  if (existingConfig == null) {
                    let sharedChannelConfig = Utils.NewChannelConfig(channelId, sharedKeyHash);
                    if (channelId === Cache.channelId) {
                      Cache.channelConfig = sharedChannelConfig;
                      MenuBar.Update();
                    }
                  } else if (trustedKey) {
                    let currentKey = DataBase.keys[existingConfig.k /*keyHash*/];
                    if (currentKey?.t /*type*/ !== 1 /*group*/) continue;
                    existingConfig.k /*keyHash*/ = sharedKeyHash;
                    Utils.FastSaveDb();
                    if (channelId === Cache.channelId) MenuBar.Update();
                  }
                }
              }
            }
            decryptWaitingMessages(sharedKeyHash);
          } catch (e) {
            break;
          }
        }
        return true;
      default:
        message.content = invalidSystemMessage;
        return false;
    }
    message.content = invalidSystemMessage;
    return true;
  }

  function processUpdateSystemMessage(message, sysmsg) {
    processSystemMessage(message, sysmsg)
      .then((delayed) => {
        if (delayed) Utils.UpdateMessageContent(message);
      })
      .catch((e) => Utils.Error(e));
  }

  // Legacy SimpleDiscordCrypt embed format
  const descriptionRegex = /^[⠀-⣿]{16,}$/;
  async function processEmbeds(message, ignoreAttachments, ctx, owner) {
    if (!isLegacyEmbed(message)) return false;
    let embed = message.embeds[0];
    if (embed.author == null) return false;

    if (embed.author.name === '-----ENCRYPTED MESSAGE-----') {
      if (!descriptionRegex.test(embed.description)) return false;
      return await decryptMessage(message, embed.description, ignoreAttachments, ctx, owner);
    } else if (embed.author.name === '-----SYSTEM MESSAGE-----') {
      processUpdateSystemMessage(message, embed.description);
    }
    return false;
  }

  function handleChannelSelect(event) {
    if (Active) {
      if (Blacklist != null) {
        let guildId = event.guildId;
        Cache.channelBlacklist = guildId == null ? null : Blacklist[guildId] ?? null;
      }
      let channelId = event.channelId;
      if (channelId != null) {
        Cache.channelId = channelId;
        Cache.channelConfig = Utils.GetChannelConfig(channelId);

        Utils.ChannelSelectEvent(channelId);
      } else {
        Cache.channelId = null;
        Cache.channelConfig = null;
      }
      //Update after event is processed by Discord
      setTimeout(() => {
        MenuBar.Update();
        PopupManager.Update();
      }, 0);
    }

    return Discord.original_dispatch.apply(this, arguments);
  }

  function handleDelete(event) {
    Utils.MessageDeleteEvent(event.id);
    return Discord.original_dispatch.apply(this, arguments);
  }
  function handleDeletes(event) {
    Utils.MessageDeleteBulkEvent(event.ids);
    return Discord.original_dispatch.apply(this, arguments);
  }

  const eventHandlers = {
    CHANNEL_SELECT: handleChannelSelect,
    MESSAGE_DELETE: handleDelete,
    MESSAGE_DELETE_BULK: handleDeletes,
  };

  /* ─────────────────────────── Outgoing messages ─────────────────────────── */

  const prefixRegex = /^(?::?ENC(?:(?:_\w*)?:|\b)|<:ENC:\d{1,20}>)\s*/;
  const noencprefixRegex = /^(?::?NOENC:?|<:NOENC:\d{1,20}>)\s*/;

  // Decides synchronously whether a message needs work, so plain messages are never delayed
  function getOutgoingPlan(channelId, content) {
    if (!Active || DataBase == null || channelId == null) return null;
    content = typeof content === 'string' ? content : '';
    const prefixMatch = prefixRegex.exec(content);
    const channelConfig = DataBase.channels[channelId];
    if (prefixMatch == null && (channelConfig == null || !channelConfig.e)) return null;

    let body = prefixMatch != null ? content.substring(prefixMatch[0].length) : content;
    if (Utils.GetChannelBlacklist(channelId) === 1) return prefixMatch != null ? { strip: body } : null;

    const noencMatch = noencprefixRegex.exec(body);
    if (noencMatch != null) return { strip: body.substring(noencMatch[0].length) };
    return { encrypt: true, body };
  }

  function formatEncryptedContent(payload) {
    const full = `${payload}\n${MessageTagLine}`;
    if (full.length <= MessageLengthLimit) return full;
    return `${payload} ${MessageTagShort}`;
  }

  // Encrypts message.content in place; returns the key used, or null if the message stays plain
  async function encryptOutgoing(channelId, message) {
    const plan = getOutgoingPlan(channelId, message.content);
    if (plan == null) return null;
    if (!plan.encrypt) {
      message.content = plan.strip;
      return null;
    }

    let channelConfig = Utils.GetChannelConfig(channelId);
    if (channelConfig == null) channelConfig = Utils.NewChannelConfig(channelId);
    const keyHash = channelConfig.k;
    const key = await Utils.GetKeyByHash(keyHash);
    if (key == null) throw new Error('the key selected for this channel is missing');

    const keyHashBytes = Utils.Base64ToBytes(keyHash);
    const messageBytes =
      plan.body !== ''
        ? Utils.ConcatBuffers([keyHashBytes, await Utils.AesEncryptCompressString(key, plan.body)])
        : keyHashBytes;

    message.content = formatEncryptedContent(Utils.PayloadEncode(messageBytes));
    return { key, keyHash };
  }

  const filenameLimit = 47;
  const filenameRegex = /^(.*?)((?:\.[^.]*)?)$/;
  async function encryptFilename(key, filename) {
    let filenameParts = filenameRegex.exec(filename);
    let filenameMax = filenameLimit - filenameParts[2].length;
    filename = filenameParts[1].substr(0, filenameMax) + filenameParts[2];

    let encryptedFilename;
    let filenameBytes = Utils.StringToUtf8Bytes(filename);
    if (filenameBytes.byteLength > filenameLimit)
      filenameBytes = Utils.StringToUtf8Bytes('file' + filenameParts[2]);
    do {
      encryptedFilename = Utils.BytesToBase64url(await Utils.AesEncrypt(key, filenameBytes));
    } while (encryptedFilename.startsWith('_') || encryptedFilename.endsWith('_')); //discord trims this character

    return encryptedFilename;
  }

  async function getChannelKeyInfo(channelId) {
    if (!Active || DataBase == null || channelId == null) return null;
    const channelConfig = DataBase.channels[channelId];
    if (channelConfig == null || !channelConfig.e || Utils.GetChannelBlacklist(channelId) === 1)
      return null;
    const key = await Utils.GetKeyByHash(channelConfig.k);
    return key == null ? null : { key, keyHash: channelConfig.k };
  }

  // CloudUpload instances whose file content we encrypted
  const encryptedUploads = new Set();
  function pruneEncryptedUploads() {
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    for (const upload of encryptedUploads)
      if (upload.__e2ee == null || upload.__e2ee.time < cutoff || upload.status === 'CANCELED')
        encryptedUploads.delete(upload);
  }
  function findEncryptedUpload(uploadedFilename) {
    if (uploadedFilename == null) return null;
    for (const upload of encryptedUploads) if (upload.uploadedFilename === uploadedFilename) return upload;
    return null;
  }

  // Runs when a file is attached: swaps in an encrypted copy before Discord uploads it
  async function handleCloudUpload() {
    let info = null;
    try {
      if (this.__e2ee == null && this.item?.file != null && this.status !== 'COMPLETED')
        info = await getChannelKeyInfo(this.channelId);
    } catch (e) {
      Utils.Error(e);
    }
    if (info == null) return await Discord.original_cloudUpload.apply(this, arguments);

    try {
      const file = this.item.file;
      const encryptedBuffer = await Utils.AesEncrypt(info.key, await Utils.ReadFile(file));
      const encryptedName = await encryptFilename(info.key, file.name || this.filename || 'file');
      const encryptedFile = new File([encryptedBuffer], encryptedName, {
        type: 'application/octet-stream',
      });

      this.item.file = encryptedFile;
      this.__e2ee = {
        keyHash: info.keyHash,
        time: Date.now(),
        originalName: this.filename || file.name || 'file',
        uploadName: encryptedName,
      };
      // don't leak anything about the original file
      this.currentSize = this.preCompressionSize = encryptedFile.size;
      this.mimeType = 'application/octet-stream';
      this._originalMd5 = undefined;
      if ('originalMd5' in this.item) this.item.originalMd5 = undefined;
      if ('compressionMetadata' in this.item) this.item.compressionMetadata = undefined;

      encryptedUploads.add(this);
      pruneEncryptedUploads();
    } catch (err) {
      Utils.Error('failed to encrypt a file, the upload was cancelled', err);
      PopupManager.Notice(`Couldn't encrypt "${this.filename ?? 'the file'}", so it was not uploaded.`);
      try {
        this.cancel?.();
      } catch (e) {}
      return;
    }

    return await Discord.original_cloudUpload.apply(this, arguments);
  }

  // Attachments arrive with plaintext names; encrypt them with the message key
  async function encryptAttachments(message, keyInfo) {
    const attachments = message.attachments;
    if (!Array.isArray(attachments) || attachments.length === 0) return;

    const unencrypted = [];
    for (const attachment of attachments) {
      const upload = findEncryptedUpload(attachment.uploaded_filename);
      if (upload == null) {
        unencrypted.push(attachment);
        continue;
      }
      encryptedUploads.delete(upload);
      if (keyInfo == null) continue; // ciphertext already, nothing else to do
      if (upload.__e2ee.keyHash !== keyInfo.keyHash)
        Utils.Warn('a file was encrypted with a different key than the message');

      // the user may have renamed the file in the draft; ignore our own upload name
      let name = attachment.filename ?? upload.filename;
      if (name == null || name === upload.__e2ee.uploadName) name = upload.__e2ee.originalName;
      if (attachment.is_spoiler && !name.startsWith('SPOILER_')) name = 'SPOILER_' + name;
      attachment.filename = await encryptFilename(keyInfo.key, name);
      delete attachment.is_spoiler;
      delete attachment.description;
      delete attachment.title;
    }

    if (keyInfo != null && unencrypted.length !== 0) {
      const send = await PopupManager.NewPromise(
        `${unencrypted.length} file(s) could not be encrypted. Send them UNENCRYPTED? Cancel sends only the encrypted text.`,
        true
      );
      if (!send) message.attachments = attachments.filter((x) => !unencrypted.includes(x));
    }
  }

  function messageHasEncryptedUploads(message) {
    return (
      Array.isArray(message.attachments) &&
      message.attachments.some((x) => findEncryptedUpload(x.uploaded_filename) != null)
    );
  }

  var sendChain = Promise.resolve();
  function handleEnqueue(packet, callback) {
    const message = packet?.message;
    const channelId = message?.channelId ?? message?.channel_id;
    if (message == null || channelId == null || packet.type === 2 /*command*/)
      return Discord.original_enqueue.apply(this, arguments);
    if (getOutgoingPlan(channelId, message.content) == null && !messageHasEncryptedUploads(message))
      return Discord.original_enqueue.apply(this, arguments);

    const self = this;
    const args = arguments;
    // keep sends in order
    sendChain = sendChain.then(async () => {
      try {
        const keyInfo = await encryptOutgoing(channelId, message);
        await encryptAttachments(message, keyInfo);
      } catch (err) {
        Utils.Error('encryption failed, the message was NOT sent', err);
        PopupManager.Notice(`Encryption failed, so your message was not sent: ${err?.message ?? err}`);
        try {
          if (typeof callback === 'function')
            callback({ ok: false, hasErr: true, status: 0, body: { message: `${AppName}: encryption failed` } });
        } catch (e) {}
        return;
      }
      Discord.original_enqueue.apply(self, args);
    });
  }

  // Fallback path when MessageQueue can't be found
  async function handleSendMessageFallback(channelId, message, options) {
    try {
      const plan = getOutgoingPlan(channelId, message?.content);
      if (plan != null) {
        const keyInfo = await encryptOutgoing(channelId, message);
        const uploads = options?.attachmentsToUpload ?? arguments[3]?.attachmentsToUpload;
        if (keyInfo != null && Array.isArray(uploads)) {
          for (const upload of uploads) {
            if (upload?.__e2ee == null) continue;
            let name = upload.filename ?? 'file';
            if (upload.spoiler && !name.startsWith('SPOILER_')) name = 'SPOILER_' + name;
            upload.filename = await encryptFilename(keyInfo.key, name);
            upload.spoiler = false;
          }
        }
      }
    } catch (err) {
      Utils.Error('encryption failed, the message was NOT sent', err);
      PopupManager.Notice(`Encryption failed, so your message was not sent: ${err?.message ?? err}`);
      return;
    }
    return await Discord.original_sendMessage.apply(this, arguments);
  }
  async function handleEditMessageFallback(channelId, messageId, message) {
    try {
      await encryptOutgoing(channelId, message);
    } catch (err) {
      Utils.Error('encryption failed, the edit was NOT sent', err);
      return;
    }
    return await Discord.original_editMessage.apply(this, arguments);
  }

  /* ──────────────────────────────── Blacklist ──────────────────────────────── */

  async function LoadBlacklist() {
    let blacklistString;
    try {
      blacklistString = Utils.Utf8BytesToString(await Utils.DownloadFile(BlacklistUrl));
    } catch (e) {
      return; // offline or blocked: no blacklist
    }
    let blacklistRegex = /^\s*(\d{1,20})(E?)/gm;
    Blacklist = {};
    let record;
    while ((record = blacklistRegex.exec(blacklistString)) != null) {
      Blacklist[record[1]] = record[2] === 'E' ? 2 : 1;
    }

    for (let i = 1; ; i++) {
      if (Utils.RefreshCache() || i === 10) break;
      await Utils.Sleep(i * 200);
    }

    MenuBar.Update();
  }

  /* ──────────────────────────────── Load ──────────────────────────────── */

  const onDocumentClick = (event) => {
    if (event.type === 'auxclick' && event.button !== 1) return;
    const target = event.target;
    if (target == null || typeof target.closest !== 'function') return;

    const anchor = target.closest('a[href]');
    const href = anchor?.getAttribute('href');
    if (href != null) {
      const tokenIndex = href.indexOf('#e2ee=');
      if (tokenIndex !== -1) {
        event.preventDefault();
        event.stopImmediatePropagation();
        decryptAndDownload(href.slice(tokenIndex + 6));
        return;
      }
      // links on decrypted media open Discord's viewer on left click; only plain links download.
      // Discord lays a transparent link over each image (a sibling of the <img>, not its parent),
      // so look at the whole media tile, not just inside the link.
      const mediaTile = anchor.closest('[class*="imageWrapper"],[class*="mosaicItem"],[class*="imageContainer"]');
      const isMediaLink =
        anchor.querySelector('img,video,canvas') != null ||
        (mediaTile != null && mediaTile.querySelector('img,video,canvas') != null);
      if (href.startsWith('blob:') && (event.type === 'auxclick' || !isMediaLink)) {
        const filename = BlobRegistry.get(href.split('#')[0]);
        if (filename != null) {
          event.preventDefault();
          event.stopImmediatePropagation();
          Utils.DownloadUrl(filename, href.split('#')[0]);
          return;
        }
      }
    }
    if (event.type === 'auxclick') {
      // middle click on decrypted media downloads it
      const media = target.closest('img,video');
      const src = media?.currentSrc || media?.src;
      if (src != null && src.startsWith('blob:')) {
        const filename = BlobRegistry.get(src.split('#')[0]);
        if (filename != null) {
          event.preventDefault();
          event.stopImmediatePropagation();
          Utils.DownloadUrl(filename, src.split('#')[0]);
        }
      }
    }
  };
  const onPageHide = () => Utils.SaveDb();

  var dbSaveInterval;
  function Load() {
    Loaded = true;
    Active = true;
    Utils.RefreshCache();
    Style.Inject();

    Discord.detour_dispatch = HandleDispatch;
    if (Discord.original_enqueue != null && Discord.hookedAliases.includes('enqueue'))
      Discord.detour_enqueue = handleEnqueue;
    if (Discord.hookedAliases.includes('sendMessage')) Discord.detour_sendMessage = handleSendMessageFallback;
    if (Discord.hookedAliases.includes('editMessage')) Discord.detour_editMessage = handleEditMessageFallback;
    if (Discord.hookedAliases.includes('cloudUpload')) Discord.detour_cloudUpload = handleCloudUpload;

    if (Discord.hookedAliases.includes('canUseEmojisEverywhere'))
      Discord.detour_canUseEmojisEverywhere = function () {
        return (
          !!Utils.GetCurrentChannelEncrypt() ||
          Discord.original_canUseEmojisEverywhere.apply(this, arguments)
        );
      };
    if (Discord.hookedAliases.includes('canUseAnimatedEmojis'))
      Discord.detour_canUseAnimatedEmojis = function () {
        return (
          !!Utils.GetCurrentChannelEncrypt() ||
          Discord.original_canUseAnimatedEmojis.apply(this, arguments)
        );
      };

    MenuBar.Show({
      getChannelId: () => Cache.channelId,
      isBlacklisted: () => Cache.channelBlacklist === 1,
      getToggleStatus: () => Utils.GetCurrentChannelEncrypt(),
      toggle: () => {
        Utils.ToggleCurrentChannelEncrypt();
        MenuBar.Update();
      },
      getCurrentKeyInfo: () => {
        let currentKeyHash = Utils.GetCurrentChannelKeyHash();
        const keyObj = DataBase.keys[currentKeyHash];
        return [
          keyObj != null ? Utils.FormatDescriptor(keyObj.d) : 'Unknown key',
          DataBase.trustedKeys != null && DataBase.trustedKeys[currentKeyHash],
        ];
      },
      getKeys: () => {
        let keys = [];
        let currentKeyHash;
        if (Cache.channelConfig != null) {
          currentKeyHash = Cache.channelConfig.k;
          let currentKeyObj = DataBase.keys[currentKeyHash];
          if (currentKeyObj?.t /*type*/ === 2 /*conversation*/)
            keys.push({
              hash: currentKeyHash,
              descriptor: Utils.FormatDescriptor(currentKeyObj.d),
              selected: true,
              trusted: DataBase.trustedKeys?.[currentKeyHash],
            });
        }

        keys.push({
          hash: DataBase.personalKeyHash,
          descriptor: Utils.FormatDescriptor(DataBase.keys[DataBase.personalKeyHash]?.d),
          selected: currentKeyHash == null || DataBase.personalKeyHash === currentKeyHash,
        });

        Object.entries(DataBase.keys)
          .filter(([hash, x]) => x.t /*type*/ === 1 /*group*/ && (!x.h /*hidden*/ || hash === currentKeyHash))
          .sort(([, a], [, b]) => b.l - a.l)
          .forEach(([hash, keyObj]) =>
            keys.push({
              hash,
              descriptor: Utils.FormatDescriptor(keyObj.d),
              selected: hash === currentKeyHash,
              trusted: DataBase.trustedKeys?.[hash],
            })
          );

        return keys;
      },
      selectKey: async (key) => {
        await Utils.SetCurrentChannelKey(key.hash);
        MenuBar.Update();
      },
      getIsDmChannel: () => Utils.GetCurrentChannelIsDm(),
      getAutoKeyExchange: () => Utils.GetAutoKeyExchangeFriends(),
      toggleAutoKeyExchange: () => Utils.ToggleAutoKeyExchangeFriends(),
      exportDb: () => Utils.DownloadDb(),
      exportDbRaw: () => Utils.DownloadDb(true),
      newDb: async () => {
        if (
          !(await PopupManager.NewPromise(
            'Start a new database? Export your current one first — every key you have will be lost.',
            true
          ))
        )
          return;
        Utils.NewDb(() => {
          Utils.RefreshCache();
          MenuBar.Update();
        });
      },
      newDbKey: () => Utils.NewDbPassword(),
      keyExchange: () => Utils.InitKeyExchange({ id: Utils.GetCurrentDmUserId() }),
      groupKey: async () => {
        await Utils.SetCurrentChannelKey(
          await Utils.SaveKey(Utils.GetRandomBytes(32), 1 /*group*/, `Group <#${Cache.channelId}>`)
        );
        MenuBar.Update();
      },
      keyManager: () => {
        let personalKeyHash = DataBase.personalKeyHash;
        let personalKey = DataBase.keys[personalKeyHash];
        const keyTypes = { 1: 'GROUP', 2: 'CONVERSATION', 3: 'PERSONAL' };
        let keys = [
          {
            hash: personalKeyHash,
            rawDescriptor: personalKey.d,
            descriptor: Utils.FormatDescriptor(personalKey.d),
            lastseen: personalKey.l,
            hidden: personalKey.h,
            type: 'PERSONAL',
            trusted: DataBase.trustedKeys != null && DataBase.trustedKeys[personalKeyHash],
            protected: true,
          },
        ];
        Object.entries(DataBase.keys)
          .sort(([, a], [, b]) => b.l - a.l)
          .forEach(([hash, keyObj]) => {
            if (hash !== personalKeyHash)
              keys.push({
                hash,
                rawDescriptor: keyObj.d,
                lastseen: keyObj.l,
                descriptor: Utils.FormatDescriptor(keyObj.d),
                hidden: keyObj.h,
                type: keyTypes[keyObj.t],
                trusted: DataBase.trustedKeys != null && DataBase.trustedKeys[hash],
              });
          });
        KeyManagerWindow.Show(
          keys,
          (key, rawDescriptor) => {
            Utils.ChangeKeyDescriptor(key.hash, rawDescriptor);
            key.rawDescriptor = DataBase.keys[key.hash].d;
            key.descriptor = Utils.FormatDescriptor(key.rawDescriptor);
            MenuBar.Update();
          },
          (key, hidden) => {
            Utils.ChangeKeyHidden(key.hash, hidden);
            key.hidden = hidden;
          },
          async (key) => {
            await Utils.DeleteKey(key.hash);
            if (Cache.channelId != null) Cache.channelConfig = DataBase.channels[Cache.channelId];
            MenuBar.Update();
          }
        );
      },
      channelManager: () =>
        ChannelManagerWindow.Show(
          Object.entries(DataBase.channels)
            .sort(([, a], [, b]) => b.l - a.l)
            .map(([id, channel]) => ({
              id,
              descriptor: Utils.FormatDescriptor(channel.d),
              lastseen: channel.l,
              encrypted: !!channel.e,
            })),
          (channel) => {
            Utils.DeleteChannelConfig(channel.id);
            if (channel.id === Cache.channelId) MenuBar.Update();
          }
        ),
      keyVisualizer: () => {
        let keyHash = Utils.GetCurrentChannelKeyHash();
        KeyVisualizerWindow.Show(Utils.Base64ToBytes(keyHash).buffer, () => {
          Utils.ToggleKeyTrusted(keyHash);
          MenuBar.Update();
        });
      },
      keyShare: () => {
        let personalKeyHash = DataBase.personalKeyHash;
        let personalKey = DataBase.keys[personalKeyHash];
        let keys = [
          {
            hash: personalKeyHash,
            descriptor: Utils.FormatDescriptor(personalKey.d),
            lastseen: personalKey.l,
          },
        ];
        keys = keys.concat(
          Object.entries(DataBase.keys)
            .filter(([, x]) => x.t /*type*/ === 1 /*group*/)
            .sort(([, a], [, b]) => b.l - a.l)
            .map(([hash, keyObj]) => ({
              hash,
              lastseen: keyObj.l,
              descriptor: Utils.FormatDescriptor(keyObj.d),
            }))
        );

        ShareKeyWindow.Show(keys, (key) => Utils.ShareKey(key.hash, Cache.channelId));
      },
    });

    PopupManager.Inject();
    VideoPatcher.Start();

    PageWindow.addEventListener('click', onDocumentClick, true);
    PageWindow.addEventListener('auxclick', onDocumentClick, true);
    PageWindow.addEventListener('pagehide', onPageHide);
    document.addEventListener('visibilitychange', onPageHide);

    dbSaveInterval = setInterval(() => Utils.SaveDb(), 10000);

    KeyRotators = {};
    if (DataBase.keyRotators != null) {
      for (let [keyHash, keyRotator] of Object.entries(DataBase.keyRotators))
        Utils.StartKeyRotation(keyHash, keyRotator);
    }

    if (DataBase.pingOn) {
      try {
        let fullRegex = /^\/(.*)\/([imsu]{0,4})$/.exec(DataBase.pingOn);
        Cache.pingOn = fullRegex ? new RegExp(fullRegex[1], fullRegex[2]) : new RegExp(DataBase.pingOn);
      } catch (e) {
        Cache.pingOn = null;
      }
    }

    Utils.Log(`v${AppVersion} loaded (${host.name || 'standalone'}) — ${AppCredit}`);

    LoadBlacklist();
  }

  function Unload() {
    if (!Loaded) return;
    Loaded = false;
    Active = false;

    for (const alias of Discord.hookedAliases || [])
      Discord[`detour_${alias}`] = Discord[`original_${alias}`];

    UnlockWindow.Remove();
    NewdbWindow.Remove();
    NewPasswordWindow.Remove();
    KeyManagerWindow.Remove();
    ChannelManagerWindow.Remove();
    ShareKeyWindow.Remove();
    MenuBar.Remove();
    PopupManager.Remove();
    KeyVisualizerWindow.Remove();
    VideoPatcher.Stop();
    Style.Remove();

    PageWindow.removeEventListener('click', onDocumentClick, true);
    PageWindow.removeEventListener('auxclick', onDocumentClick, true);
    PageWindow.removeEventListener('pagehide', onPageHide);
    document.removeEventListener('visibilitychange', onPageHide);

    clearInterval(dbSaveInterval);
    for (const timeout of Object.values(KeyRotators)) clearTimeout(timeout);
    KeyRotators = {};
    Utils.SaveDb();

    Utils.Log('unloaded');
  }

  /* ───────────────────────────── Console helpers ───────────────────────────── */

  const ConsoleApi = {
    ClearKeys: (filterFunc) => {
      const typeLookup = [null, 'GROUP', 'CONVERSATION', 'PERSONAL'];
      for (let [hash, keyObj] of Object.entries(DataBase.keys)) {
        if (
          filterFunc({
            type: typeLookup[keyObj.t],
            lastseen: keyObj.l,
            descriptor: Utils.FormatDescriptor(keyObj.d),
            hidden: !!keyObj.h,
            registered: keyObj.r,
          })
        )
          Utils.DeleteKey(hash);
      }
    },
    ClearChannels: (filterFunc) => {
      for (let [id, channelObj] of Object.entries(DataBase.channels)) {
        if (
          filterFunc({
            lastseen: channelObj.l,
            descriptor: Utils.FormatDescriptor(channelObj.d),
            encrypted: !!channelObj.e,
          })
        )
          Utils.DeleteChannelConfig(id);
      }
    },
    SetPingOn: (regexStr) => {
      if (!regexStr) {
        if (Cache.pingOn == null) return;
        Cache.pingOn = null;
        delete DataBase.pingOn;
      } else {
        regexStr = regexStr.toString();
        let fullRegex = /^\/(.*)\/([imsu]{0,4})$/.exec(regexStr);
        Cache.pingOn = fullRegex ? new RegExp(fullRegex[1], fullRegex[2]) : new RegExp(regexStr);
        DataBase.pingOn = regexStr;
      }
      Utils.FastSaveDb();
    },
    SetKeyRotation: (days, start) => {
      days = Number(days);
      if (start != null) {
        start = Date.parse(start);
        if (!start) {
          Utils.Error('Invalid start time');
          return;
        }
      }
      let channelConfig = Cache.channelConfig;
      if (channelConfig == null) {
        Utils.Error('There is no key selected in this channel');
        return;
      }
      let keyHash = channelConfig.k; /*keyHash*/
      let keyRotator;
      if (DataBase.keyRotators != null) keyRotator = DataBase.keyRotators[keyHash];
      if (days > 0) {
        const day = 24 * 60 * 60 * 1000;
        let interval = days * day;
        if (start == null) {
          let now = Date.now();
          start = now - (now % interval) + interval;
          if (start < now + day) start += interval;
        }
        if (keyRotator == null) {
          let keyType = DataBase.keys[keyHash].t; /*type*/
          if (keyType === 3 /*personal*/) {
            Utils.Error('You cannot add key rotation to your personal key');
            return;
          }
          if (keyType === 2 /*conversation*/) {
            Utils.Error('You cannot use key rotation for key exchanges');
            return;
          }
          if (DataBase.keyRotators == null) DataBase.keyRotators = {};
          keyRotator = DataBase.keyRotators[keyHash] = { interval, start, seed: keyHash };
          Utils.StartKeyRotation(keyHash, keyRotator);
        } else {
          if (keyRotator.start < Date.now())
            Utils.Warn("Please note that the numbering has been reset, you might want to change the key's name");
          keyRotator.interval = interval;
          keyRotator.start = start;
          Utils.StopKeyRotation(keyHash);
          Utils.StartKeyRotation(keyHash, keyRotator);
        }
        if (DataBase.dhPrivateKeyFallback)
          Utils.Warn(
            'You are using compatibility mode, make sure to remove all key rotation if you import the database into other devices'
          );
        Utils.Log('Key rotation will start on ' + new Date(start));
      } else {
        if (keyRotator == null) {
          Utils.Error('There is no key rotation on the current key');
          return;
        }
        delete DataBase.keyRotators[keyHash];
        if (Object.keys(DataBase.keyRotators).length === 0) delete DataBase.keyRotators;
        Utils.StopKeyRotation(keyHash);
        delete KeyRotators[keyHash];
        Utils.Log('Key rotation stopped');
      }
      Utils.FastSaveDb();
    },
  };
  const exposeConsoleApi = () => {
    for (const [name, fn] of Object.entries(ConsoleApi)) {
      PageWindow[`E2EE${name}`] = fn;
      PageWindow[`Sdc${name}`] = fn; // SimpleDiscordCrypt-compatible names
    }
  };
  const removeConsoleApi = () => {
    for (const name of Object.keys(ConsoleApi)) {
      if (PageWindow[`E2EE${name}`] === ConsoleApi[name]) delete PageWindow[`E2EE${name}`];
      if (PageWindow[`Sdc${name}`] === ConsoleApi[name]) delete PageWindow[`Sdc${name}`];
    }
  };

  /* ──────────────────────────────── Lifecycle ──────────────────────────────── */

  var InitStarted = false;
  var InitStopped = false;
  var InitAttempts = 0;
  function TryInit() {
    if (InitStopped) return;
    InitAttempts++;
    let result;
    try {
      result = Init(InitAttempts === 150);
    } catch (e) {
      Utils.Error(e);
      result = -1;
    }
    if (result !== 0) return;
    // a runtime we haven't seen may have been installed since: look again now and then
    if (InitAttempts % 10 === 0) Utils.cachedWebpack = null;
    setTimeout(TryInit, InitAttempts < 150 ? 200 : 2000);
  }

  return {
    name: AppName,
    version: AppVersion,
    ready: InitPromise,
    start: function () {
      InitStopped = false;
      exposeConsoleApi();
      if (!InitStarted) {
        InitStarted = true;
        Utils.Log(`injected — ${AppCredit}`);
        TryInit();
      } else if (Initialized && !Loaded && DataBase != null) {
        Load();
      } else if (!Initialized) {
        TryInit();
      }
    },
    stop: function () {
      InitStopped = true;
      removeConsoleApi();
      if (Loaded) Unload();
    },
  };
}

E2EEDiscord({ name: 'userscript' }).start();
})();
