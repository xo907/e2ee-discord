
module.exports = class E2EEDiscordPlugin {
  constructor(meta) {
    this.meta = meta;
    this.instance = null;
  }

  start() {
    if (this.instance == null) {
      this.instance = E2EEDiscord({
        name: 'betterdiscord',
        window,
        storage: {
          get: async (key) => BdApi.Data.load('E2EEDiscord', key) ?? null,
          set: async (key, value) => BdApi.Data.save('E2EEDiscord', key, value),
        },
        // Discord's CDN blocks the page from reading attachments; BdApi.Net.fetch runs outside it
        fetchBinary:
          typeof BdApi.Net?.fetch === 'function'
            ? async (url) => {
                const response = await BdApi.Net.fetch(url);
                if (!response.ok) throw new Error(`HTTP ${response.status}`);
                return await response.arrayBuffer();
              }
            : undefined,
      });
    }
    this.instance.start();
  }

  stop() {
    if (this.instance != null) this.instance.stop();
  }
};
