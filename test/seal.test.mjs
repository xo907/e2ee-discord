// Message format and seals, checked against an independent implementation (node:crypto)
import test from 'node:test';
import assert from 'node:assert/strict';
import { createDecipheriv, createHmac, hkdfSync, createHash } from 'node:crypto';
import { FakeServer, FakeClient, DecryptedMarker, stripMarker } from './helpers/harness.mjs';

// The message pattern exactly as E2EE-Discord 2.0.2 shipped it: sealed messages must still match
const v2MessageRegex =
  /^([⠀-⣿]{16,})(?:[ \t]*`(?:SimpleDiscordCrypt|𝘚𝘪𝘮𝘱𝘭𝘦𝘋𝘪𝘴𝘤𝘰𝘳𝘥𝘊𝘳𝘺𝘱𝘵)`|\s+[^\n]*e2ee-discord[^\n]*)$/i;
const sealedTag = /\n-# 🔒 Encrypted with \[E2EE-Discord\]\(<https:\/\/github\.com\/xo907\/e2ee-discord#s=([A-Za-z0-9_-]{22})>\)$/;

const fromBraille = (text) => Buffer.from(Array.from(text, (c) => c.charCodeAt(0) - 0x2800));
const toBraille = (bytes) => String.fromCharCode(...Array.from(bytes, (b) => b + 0x2800));

/** PROTOCOL.md "Seal", written from the spec rather than from the plugin's code */
function referenceSeal(rawKey, payloadBytes) {
  const macKey = Buffer.from(hkdfSync('sha256', rawKey, Buffer.alloc(0), 'E2EE-Discord seal v1', 32));
  return createHmac('sha256', macKey).update(payloadBytes).digest().subarray(0, 16).toString('base64url');
}

async function setup(t) {
  const server = new FakeServer();
  const alice = await new FakeClient(server, 'Alice').start();
  t.after(() => alice.stop());
  const channel = server.guildChannel();
  alice.select(channel);
  alice.utils.ToggleCurrentChannelEncrypt();
  const keyHash = alice.db.personalKeyHash;
  const rawKey = Buffer.from(alice.db.keys[keyHash].k, 'base64');
  return { server, alice, channel, keyHash, rawKey };
}

test('an outgoing message is encrypted, sealed, and still matches the 2.x pattern', async (t) => {
  const { alice, channel, keyHash, rawKey } = await setup(t);
  const [wire] = await alice.say(channel, 'hello sealed world ✓');

  assert.ok(!wire.content.includes('hello'), 'plaintext must not reach the wire');
  const v2 = v2MessageRegex.exec(wire.content);
  assert.ok(v2, '2.x clients must still recognise the message');
  const seal = sealedTag.exec(wire.content)?.[1];
  assert.ok(seal, 'the tag line carries a seal');

  const payload = fromBraille(v2[1]);
  assert.equal(payload.subarray(0, 16).toString('base64'), keyHash, 'payload starts with the key id');
  assert.equal(createHash('sha512').update(rawKey).digest().subarray(0, 16).toString('base64'), keyHash);

  // a 2.x client ignores the seal and decrypts with AES-256-CBC
  const decipher = createDecipheriv('aes-256-cbc', rawKey, payload.subarray(16, 32));
  const plain = Buffer.concat([decipher.update(payload.subarray(32)), decipher.final()]).toString('utf8');
  assert.equal(plain, 'hello sealed world ✓');

  assert.equal(seal, referenceSeal(rawKey, payload), 'seal matches the specification');
});

test('the sender sees their own sealed message decrypted', async (t) => {
  const { alice, channel } = await setup(t);
  await alice.say(channel, 'round trip');
  const shown = alice.lastReceived(channel).content;
  assert.match(shown, DecryptedMarker);
  assert.equal(stripMarker(shown), 'round trip');
});

test('a message altered in transit is refused', async (t) => {
  const { server, alice, channel } = await setup(t);
  // flip one bit in the last ciphertext block, the classic CBC bit-flipping attack
  server.intercept = (wire) => {
    const match = v2MessageRegex.exec(wire.content);
    const payload = fromBraille(match[1]);
    payload[payload.length - 20] ^= 0x01;
    return { ...wire, content: toBraille(payload) + wire.content.slice(match[1].length) };
  };
  await alice.say(channel, 'pay 100 to Bob');
  const shown = alice.lastReceived(channel).content;
  assert.match(shown, /altered after it was sent/);
  assert.ok(!shown.includes('pay'), 'none of the altered text is shown');
  assert.doesNotMatch(shown, DecryptedMarker);
});

test('a forged seal is refused', async (t) => {
  const { server, alice, channel } = await setup(t);
  server.intercept = (wire) => ({ ...wire, content: wire.content.replace(/#s=[A-Za-z0-9_-]{22}/, '#s=AAAAAAAAAAAAAAAAAAAAAA') });
  await alice.say(channel, 'secret');
  assert.match(alice.lastReceived(channel).content, /altered after it was sent/);
});

test('a seal made with another key is refused', async (t) => {
  const { server, alice, channel, rawKey } = await setup(t);
  server.intercept = (wire) => {
    const payload = fromBraille(v2MessageRegex.exec(wire.content)[1]);
    const otherKey = Buffer.from(rawKey).fill(7);
    return { ...wire, content: wire.content.replace(/#s=[A-Za-z0-9_-]{22}/, `#s=${referenceSeal(otherKey, payload)}`) };
  };
  await alice.say(channel, 'secret');
  assert.match(alice.lastReceived(channel).content, /altered after it was sent/);
});

test('unsealed messages from 2.x clients are still read', async (t) => {
  const { server, alice, channel } = await setup(t);
  // what 2.0.2 sends: same payload, tag line without a seal
  server.intercept = (wire) => ({ ...wire, content: wire.content.replace(/#s=[A-Za-z0-9_-]{22}/, '') });
  await alice.say(channel, 'from an old client');
  const shown = alice.lastReceived(channel).content;
  assert.equal(stripMarker(shown), 'from an old client');
  assert.ok(!shown.includes('Not sealed'), 'no warning unless the channel requires seals');
});

test('"Require sealed messages" flags unsealed messages, and only those', async (t) => {
  const { server, alice, channel } = await setup(t);
  alice.utils.ToggleCurrentChannelRequireSeal();
  assert.equal(alice.db.channels[channel].q, 1);

  await alice.say(channel, 'sealed one');
  assert.equal(stripMarker(alice.lastReceived(channel).content), 'sealed one');

  server.intercept = (wire) => ({ ...wire, content: wire.content.replace(/#s=[A-Za-z0-9_-]{22}/, '') });
  await alice.say(channel, 'stripped one');
  const shown = alice.lastReceived(channel).content;
  assert.ok(shown.startsWith('<:ENC:'));
  assert.match(shown, /stripped one\n-# ⚠️ Not sealed/);

  alice.utils.ToggleCurrentChannelRequireSeal();
  assert.equal(alice.db.channels[channel].q, undefined);
});

test('legacy SimpleDiscordCrypt-tagged messages are still read', async (t) => {
  const { server, alice, channel } = await setup(t);
  server.intercept = (wire) => ({ ...wire, content: v2MessageRegex.exec(wire.content)[1] + '`SimpleDiscordCrypt`' });
  await alice.say(channel, 'old friend');
  assert.equal(stripMarker(alice.lastReceived(channel).content), 'old friend');
});

test('ENC and NOENC prefixes override the channel setting', async (t) => {
  const { alice, channel } = await setup(t);
  const [plain] = await alice.say(channel, 'NOENC out in the open');
  assert.equal(plain.content, 'out in the open');

  alice.utils.ToggleCurrentChannelEncrypt(); // off
  const [stillPlain] = await alice.say(channel, 'nothing to hide');
  assert.equal(stillPlain.content, 'nothing to hide');
  const [forced] = await alice.say(channel, 'ENC just this one');
  assert.match(forced.content, sealedTag);
  assert.equal(stripMarker(alice.lastReceived(channel).content), 'just this one');
});

test('a long message (just under the compression threshold) round-trips', async (t) => {
  const { alice, channel } = await setup(t);
  const text = 'x'.repeat(1590);
  const [wire] = await alice.say(channel, text);
  assert.ok(wire.content.length <= 2000, `content is ${wire.content.length} characters`);
  assert.match(wire.content, sealedTag);
  assert.equal(stripMarker(alice.lastReceived(channel).content), text);
});
