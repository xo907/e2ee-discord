// E2EE-Discord — Made by XO.ST
// Runs in the extension's isolated world. The page-side script (e2ee-discord.js) asks it to
// store the key database in extension storage and to download files the page's CSP blocks.

const StorageKeys = new Set(['E2EEDiscord', 'SimpleDiscordCrypt']);
const WritableStorageKeys = new Set(['E2EEDiscord']);
const FetchAllowed =
  /^https:\/\/(?:cdn\.discordapp\.com|media\.discordapp\.net|raw\.githubusercontent\.com\/xo907\/e2ee-discord)\//;

window.addEventListener('message', async (event) => {
  if (event.source !== window || event.data?.__e2eeBridge !== 1) return;
  const port = event.ports?.[0];
  if (port == null) return;

  const { op, payload } = event.data;
  try {
    if (op === 'storage.get') {
      const key = String(payload?.key);
      if (!StorageKeys.has(key)) throw new Error('storage key not allowed');
      const stored = await chrome.storage.local.get(key);
      port.postMessage({ result: stored[key] ?? null });
    } else if (op === 'storage.set') {
      const key = String(payload?.key);
      if (!WritableStorageKeys.has(key)) throw new Error('storage key not allowed');
      await chrome.storage.local.set({ [key]: payload.value });
      port.postMessage({ result: true });
    } else if (op === 'fetch') {
      const url = String(payload?.url);
      if (!FetchAllowed.test(url)) throw new Error('host not allowed');
      const response = await fetch(url, { credentials: 'omit' });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const buffer = await response.arrayBuffer();
      port.postMessage({ result: buffer }, [buffer]);
    } else {
      throw new Error('unknown operation');
    }
  } catch (error) {
    port.postMessage({ error: String(error?.message ?? error) });
  }
});
