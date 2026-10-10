// E2EE-Discord test harness — Made by XO.ST
//
// Runs the real src/core.js in Node against a fake Discord: just enough DOM for the core
// to build its UI, and just enough of Discord's modules (dispatcher, stores, message queue)
// for messages to travel between clients. No dependencies.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const corePath = fileURLToPath(new URL('../../src/core.js', import.meta.url));

/* ───────────────────────────── minimal DOM ───────────────────────────── */

class FakeElement {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase();
    this.children = [];
    this.parentElement = null;
    this.style = {};
    this.listeners = {};
    this.attributes = {};
    this.className = '';
    this.value = '';
    this.isConnected = false;
    this._text = '';
    this.classList = {
      add: () => {},
      remove: () => {},
      toggle: () => {},
      contains: () => false,
    };
  }
  // the core only uses textContent/innerHTML to escape text
  set textContent(value) {
    this._text = String(value);
  }
  get textContent() {
    return this._text;
  }
  set innerHTML(value) {
    this._text = String(value);
  }
  get innerHTML() {
    return this._text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
  get lastChild() {
    return this.children[this.children.length - 1] ?? new FakeElement('span');
  }
  appendChild(child) {
    child.parentElement = this;
    child.isConnected = true;
    this.children.push(child);
    return child;
  }
  prepend(child) {
    child.parentElement = this;
    child.isConnected = true;
    this.children.unshift(child);
  }
  remove() {
    this.isConnected = false;
    this.parentElement = null;
  }
  contains() {
    return false;
  }
  addEventListener(type, listener) {
    (this.listeners[type] ??= []).push(listener);
  }
  removeEventListener() {}
  setAttribute(name, value) {
    this.attributes[name] = value;
  }
  getAttribute(name) {
    return this.attributes[name] ?? null;
  }
  getElementsByClassName() {
    return [];
  }
  querySelector() {
    return null;
  }
  querySelectorAll() {
    return [];
  }
  getBoundingClientRect() {
    return { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 };
  }
  focus() {}
  select() {}
  click() {}
}

export function installDom() {
  if (globalThis.document != null) return;
  const document = new FakeElement('#document');
  document.createElement = (tag) => new FakeElement(tag);
  document.head = new FakeElement('head');
  document.body = new FakeElement('body');
  document.documentElement = new FakeElement('html');
  globalThis.document = document;
  globalThis.MutationObserver = class {
    observe() {}
    disconnect() {}
  };
  globalThis.Node = FakeElement;
  // nothing in the tests may reach the network (the core downloads a server blacklist)
  globalThis.fetch = async () => {
    throw new Error('offline');
  };
  if (!process.env.E2EE_TEST_VERBOSE) console.log = console.warn = () => {};
}

/* ───────────────────────────── fake Discord ───────────────────────────── */

let nextId = 1000n;
const snowflake = () => String(nextId++);

/** The "server": delivers what one client sends to everyone in the channel. */
export class FakeServer {
  constructor() {
    this.clients = [];
    this.channels = new Map(); // id -> { id, type, recipients: [userId…], guild_id }
    this.log = []; // every message as it travelled over the wire
    this.intercept = null; // (message) => message | null, to tamper with or drop traffic
    this.lastDelivery = Promise.resolve();
    this.clock = 0;
  }
  // Discord orders key-exchange messages by timestamp, so no two may share a millisecond
  now() {
    this.clock = Math.max(Date.now(), this.clock + 1);
    return new Date(this.clock).toISOString();
  }
  dm(a, b) {
    const id = snowflake();
    this.channels.set(id, { id, type: 1, members: [a.user.id, b.user.id] });
    return id;
  }
  guildChannel(guildId = '5000') {
    const id = snowflake();
    this.channels.set(id, { id, type: 0, guild_id: guildId, members: null });
    return id;
  }
  channelFor(client, channelId) {
    const channel = this.channels.get(channelId);
    if (channel == null) return null;
    if (channel.type !== 1) return { id: channel.id, type: 0, guild_id: channel.guild_id, name: 'general' };
    if (!channel.members.includes(client.user.id)) return null;
    return { id: channel.id, type: 1, recipients: channel.members.filter((id) => id !== client.user.id) };
  }
  send(author, channelId, content, extra = {}) {
    let wire = {
      id: snowflake(),
      channel_id: channelId,
      content,
      author: { ...author.user },
      timestamp: this.now(),
      attachments: [],
      embeds: [],
      ...extra,
    };
    if (this.intercept != null) wire = this.intercept(wire);
    if (wire == null) return null;
    this.log.push(wire);
    const channel = this.channels.get(channelId);
    const deliveries = [];
    for (const client of this.clients) {
      if (channel.members != null && !channel.members.includes(client.user.id)) continue;
      deliveries.push(client.receive(structuredClone(wire)));
    }
    this.lastDelivery = Promise.all(deliveries);
    return wire;
  }
}

/** One Discord client with the plugin loaded. */
export class FakeClient {
  constructor(server, name, { storage = {}, selectedChannel = null } = {}) {
    installDom();
    this.server = server;
    this.user = { id: snowflake(), username: name.toLowerCase(), globalName: name, discriminator: '0' };
    this.selectedChannel = selectedChannel;
    this.received = []; // messages as Discord's UI would show them (after the plugin)
    this.sendFailures = [];
    this.notices = [];
    this.prompts = [];
    this.answerPrompts = true;
    this.storage = storage;
    server.clients.push(this);

    const client = this;
    class UserStore {
      static displayName = 'UserStore';
      getUser = (id) => server.clients.find((c) => c.user.id === id)?.user ?? null;
      getCurrentUser = () => client.user;
      getUsers = () => ({});
    }
    class ChannelStore {
      static displayName = 'ChannelStore';
      getChannel = (id) => server.channelFor(client, id);
      getDMFromUserId = (userId) => {
        for (const channel of server.channels.values())
          if (channel.type === 1 && channel.members.includes(userId) && channel.members.includes(client.user.id))
            return channel.id;
        return null;
      };
    }
    class SelectedChannelStore {
      static displayName = 'SelectedChannelStore';
      getChannelId = () => client.selectedChannel;
      getVoiceChannelId = () => null;
      getLastSelectedChannelId = () => client.selectedChannel;
    }
    class RelationshipStore {
      static displayName = 'RelationshipStore';
      isFriend = () => false;
      isBlocked = () => false;
      getFriendIDs = () => [];
    }
    this.dispatcher = {
      dispatch: (event) => {
        if (event.type === 'MESSAGE_CREATE') client.received.push(event.message);
        if (event.type === 'MESSAGE_UPDATE') {
          const index = client.received.findIndex((m) => m.id === event.message.id);
          if (index !== -1) client.received[index] = event.message;
        }
      },
      subscribe: () => {},
      addInterceptor: () => {},
    };
    this.messageQueue = {
      enqueue: (packet, callback) => {
        const message = packet.message;
        server.send(client, message.channelId ?? message.channel_id, message.content);
        if (typeof callback === 'function') callback({ ok: true });
      },
      handleSend: () => {},
    };

    const modules = [this.dispatcher, new UserStore(), new ChannelStore(), new SelectedChannelStore(), new RelationshipStore(), this.messageQueue];
    const cache = {};
    modules.forEach((exports, index) => {
      cache[index] = { exports, loaded: true };
    });
    const chunk = [];
    chunk.push = (entry) => {
      const callback = entry?.[2];
      if (typeof callback === 'function') callback({ c: cache });
    };

    this.window = {
      webpackChunkdiscord_app: chunk,
      crypto: globalThis.crypto,
      localStorage: null,
      innerWidth: 1280,
      innerHeight: 800,
      addEventListener: () => {},
      removeEventListener: () => {},
      open: () => {},
    };

    const E2EEDiscord = new Function(`${readFileSync(corePath, 'utf8')}\nreturn E2EEDiscord;`)();
    this.plugin = E2EEDiscord({
      name: 'test',
      window: this.window,
      testHooks: true,
      storage: {
        get: async (key) => (key in this.storage ? structuredClone(this.storage[key]) : null),
        set: async (key, value) => {
          this.storage[key] = structuredClone(value);
        },
      },
      fetchBinary: async () => {
        throw new Error('offline'); // no blacklist download in tests
      },
    });
    this.internals = this.plugin.internals;

    // consent prompts and notices are answered here instead of by clicking
    this.internals.PopupManager.Inject = () => {};
    this.internals.PopupManager.Notice = (message) => void this.notices.push(message);
    this.internals.PopupManager.NewPromise = async (message) => {
      this.prompts.push(message);
      return this.answerPrompts;
    };
  }

  /** Starts the plugin. `password` answers the new-database or unlock window. */
  async start({ password = '' } = {}) {
    const { internals } = this;
    internals.NewdbWindow.Show = (create) => void create(password);
    this.autoPassword = password;
    internals.UnlockWindow.Show = (tryPassword, newDb, cancel, locked) => {
      this.unlockAttempt = tryPassword;
      this.lockScreenShown = !!locked;
      if (this.autoPassword != null) void tryPassword(this.autoPassword);
    };
    this.plugin.start();
    if (password == null) return this; // left waiting at the unlock window
    await this.plugin.ready;
    return this;
  }

  get db() {
    return this.internals.DataBase;
  }
  get utils() {
    return this.internals.Utils;
  }

  /** What the user types in a channel. Resolves once the server has delivered it. */
  async say(channelId, content) {
    const before = this.server.log.length;
    // encrypted sends are asynchronous: the plugin calls the real enqueue (and this callback) later
    const result = await new Promise((resolve) => {
      this.messageQueue.enqueue({ type: 0, message: { channelId, content, nonce: snowflake() } }, resolve);
    });
    if (result?.ok === false) this.sendFailures.push(result);
    // a locked client holds its incoming messages, so don't wait for delivery forever
    await Promise.race([this.server.lastDelivery, settle(400)]);
    await settle(10);
    return this.server.log.slice(before);
  }

  /** A gateway event arriving from the server, through the plugin's dispatch hook. */
  async receive(message) {
    await this.dispatcher.dispatch({ type: 'MESSAGE_CREATE', channelId: message.channel_id, message });
  }

  select(channelId) {
    this.selectedChannel = channelId;
    this.dispatcher.dispatch({ type: 'CHANNEL_SELECT', channelId, guildId: this.server.channels.get(channelId)?.guild_id ?? null });
  }

  lastReceived(channelId) {
    for (let i = this.received.length - 1; i >= 0; i--)
      if (this.received[i].channel_id === channelId) return this.received[i];
    return null;
  }

  stop() {
    this.plugin.stop();
  }
}

/** Lets queued promise chains and short timers (database saves, key exchange steps) finish. */
export const settle = (ms = 60) => new Promise((resolve) => setTimeout(resolve, ms));

/** Waits until check() is truthy. */
export async function until(check, what = 'condition', timeout = 5000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await settle(20);
  }
}

// markers the plugin puts in front of decrypted text
export const DecryptedMarker = /^<:ENC:\d+>/;
export const stripMarker = (content) => content.replace(/^<:ENC(?:_\w*)?:\d+>/, '');
