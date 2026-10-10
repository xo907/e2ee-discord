// Two clients, each running the real plugin, talking through a fake Discord
import test from 'node:test';
import assert from 'node:assert/strict';
import { FakeServer, FakeClient, until, stripMarker } from './helpers/harness.mjs';

const KEY_TYPE_CONVERSATION = 2;

async function pair(t) {
  const server = new FakeServer();
  const alice = await new FakeClient(server, 'Alice').start();
  const bob = await new FakeClient(server, 'Bob').start();
  t.after(() => {
    alice.stop();
    bob.stop();
  });
  const dm = server.dm(alice, bob);
  return { server, alice, bob, dm };
}

async function exchange({ alice, bob, dm }) {
  alice.select(dm);
  bob.select(dm);
  await alice.utils.InitKeyExchange({ id: bob.user.id });
  const dmKey = (client) => {
    const hash = client.db.channels[dm]?.k;
    return client.db.keys[hash]?.t === KEY_TYPE_CONVERSATION ? hash : null;
  };
  await until(() => dmKey(alice) && dmKey(bob) && !alice.db.channels[dm].w && !bob.db.channels[dm].w, 'the key exchange to finish');
  return dmKey(alice);
}

test('a DM key exchange gives both sides the same key without it crossing the wire', async (t) => {
  const ctx = await pair(t);
  const { server, alice, bob, dm } = ctx;
  const keyHash = await exchange(ctx);

  assert.equal(bob.db.channels[dm].k, keyHash, 'both sides derived the same key');
  const aliceKey = Buffer.from(await alice.utils.GetKeyBytesByHash(keyHash));
  const bobKey = Buffer.from(await bob.utils.GetKeyBytesByHash(keyHash));
  assert.ok(aliceKey.equals(bobKey));

  // the three protocol messages, in order, and nothing else
  const types = server.log.map((wire) => /\*type\*: `([^`]+)`/.exec(wire.content)?.[1]);
  assert.deepEqual(types, ['DH KEY', 'DH RESPONSE', 'PERSONAL KEY']);
  const braille = (bytes) => String.fromCharCode(...Array.from(bytes, (b) => b + 0x2800));
  for (const wire of server.log) {
    assert.ok(!wire.content.includes(braille(aliceKey)), 'the shared secret never appears on the wire');
    assert.match(wire.content, /e2ee-discord/);
  }

  // each side also learned the other's personal key
  assert.ok(alice.db.keys[bob.db.personalKeyHash], "Alice has Bob's personal key");
  assert.ok(bob.db.keys[alice.db.personalKeyHash], "Bob has Alice's personal key");
  assert.ok(bob.prompts.some((prompt) => /Accept a key exchange/.test(prompt)), 'Bob was asked before answering');
});

test('after the exchange, sealed messages flow both ways', async (t) => {
  const ctx = await pair(t);
  const { alice, bob, dm } = ctx;
  await exchange(ctx);

  alice.utils.ToggleCurrentChannelEncrypt();
  bob.utils.ToggleCurrentChannelEncrypt();

  const [toBob] = await alice.say(dm, 'hi Bob, this is private');
  assert.ok(!toBob.content.includes('private'));
  assert.match(toBob.content, /#s=[A-Za-z0-9_-]{22}>\)$/);
  assert.equal(stripMarker(bob.lastReceived(dm).content), 'hi Bob, this is private');

  await bob.say(dm, 'loud and clear 🔒');
  assert.equal(stripMarker(alice.lastReceived(dm).content), 'loud and clear 🔒');
});

test('a tampered message is refused by the receiver too', async (t) => {
  const ctx = await pair(t);
  const { server, alice, bob, dm } = ctx;
  await exchange(ctx);
  alice.utils.ToggleCurrentChannelEncrypt();

  server.intercept = (wire) => {
    const chars = Array.from(wire.content);
    chars[40] = String.fromCharCode(chars[40].charCodeAt(0) ^ 0x10); // inside the ciphertext
    return { ...wire, content: chars.join('') };
  };
  await alice.say(dm, 'meet at noon');
  const shown = bob.lastReceived(dm).content;
  assert.match(shown, /altered after it was sent/);
  assert.ok(!shown.includes('noon'));
});

test('declining the prompt leaves no key behind', async (t) => {
  const { alice, bob, dm } = await pair(t);
  bob.answerPrompts = false;
  alice.select(dm);
  await alice.utils.InitKeyExchange({ id: bob.user.id });
  await until(() => bob.prompts.length > 0, 'Bob to be asked');
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(Object.keys(bob.db.keys).length, 1, 'Bob only has his own personal key');
  assert.equal(Object.keys(alice.db.keys).length, 1, 'Alice only has her own personal key');
});

test('a group key is requested and shared automatically over the secure DM', async (t) => {
  const ctx = await pair(t);
  const { server, alice, bob } = ctx;
  await exchange(ctx);

  const room = server.guildChannel();
  alice.select(room);
  bob.select(room);
  const groupHash = await alice.utils.SaveKey(alice.utils.GetRandomBytes(32), 1 /*group*/, 'Book club');
  await alice.utils.SetCurrentChannelKey(groupHash);
  alice.utils.ToggleCurrentChannelEncrypt();

  await alice.say(room, 'first rule of book club');
  // Bob has no key yet: he asks Alice over their DM, she shares it, and the message appears
  await until(() => bob.db.keys[groupHash], 'Bob to receive the group key');
  await until(() => stripMarker(bob.lastReceived(room).content.replace(/^<:ENC_\w*:\d+>/, '')) === 'first rule of book club', 'the waiting message to be decrypted');

  assert.equal(bob.db.keys[groupHash].d, 'Book club');
  assert.equal(bob.db.keys[groupHash].t, 1);
  assert.equal(bob.db.channels[room]?.k, groupHash, 'the channel was switched to the shared key');
  assert.ok(alice.prompts.some((prompt) => /Share the key "Book club"/.test(prompt)), 'Alice was asked before sharing');
  const types = server.log.map((wire) => /\*type\*: `([^`]+)`/.exec(wire.content)?.[1]).filter(Boolean);
  assert.deepEqual(types.slice(-2), ['KEY REQUEST', 'KEY SHARE']);
});
