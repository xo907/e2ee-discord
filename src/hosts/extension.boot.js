
// Runs in the page ("MAIN" world). Storage and cross-origin downloads go through
// bridge.js, which runs in the extension's isolated world.
const E2EEBridgeCall = (op, payload) =>
  new Promise((resolve, reject) => {
    const channel = new MessageChannel();
    channel.port1.onmessage = (event) => {
      channel.port1.close();
      const data = event.data || {};
      if (data.error != null) reject(new Error(data.error));
      else resolve(data.result);
    };
    window.postMessage({ __e2eeBridge: 1, op, payload }, location.origin, [channel.port2]);
  });

E2EEDiscord({
  name: 'extension',
  window,
  storage: {
    get: async (key) => (await E2EEBridgeCall('storage.get', { key })) ?? null,
    set: (key, value) => E2EEBridgeCall('storage.set', { key, value }),
  },
  fetchBinary: (url) => E2EEBridgeCall('fetch', { url }),
}).start();
