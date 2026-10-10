// Locking: keys leave memory, nothing can leak as plain text, and messages wait for the unlock
import test from 'node:test';
import assert from 'node:assert/strict';
import { FakeServer, FakeClient, settle, until, stripMarker } from './helpers/harness.mjs';

const password = 'open sesame';

async function setup(t, options = { password }) {
  const server = new FakeServer();
  const alice = await new FakeClient(server, 'Alice').start(options);
  t.after(() => alice.stop());
  const secret = server.guildChannel();
  const lobby = server.guildChannel();
  alice.select(secret);
  alice.utils.ToggleCurrentChannelEncrypt();
  alice.autoPassword = null; // from here on the tests answer the lock screen themselves
  return { server, alice, secret, lobby };
}

test('locking clears every key from memory and shows the lock screen', async (t) => {
  const { alice, secret } = await setup(t);
  await alice.say(secret, 'warm the caches');
  assert.ok(alice.internals.Cache.dbKey, 'vault key is in memory while unlocked');
  assert.notEqual(Object.keys(alice.internals.Cache.keys).length, 0);

  assert.equal(alice.utils.LockDb(), true);
  assert.equal(alice.internals.Locked, true);
  assert.equal(alice.internals.Active, false);
  assert.equal(alice.lockScreenShown, true);
  assert.equal(alice.internals.Cache.dbKey, null);
  assert.deepEqual(alice.internals.Cache.keys, {});
  assert.deepEqual(alice.internals.Cache.macKeys, {});
  assert.equal(alice.utils.LockDb(), false, 'locking twice does nothing');
});

test('while locked, nothing is sent to an encrypted channel, not even as plain text', async (t) => {
  const { server, alice, secret, lobby } = await setup(t);
  alice.utils.LockDb();
  const before = server.log.length;

  const sent = await alice.say(secret, 'this must not leak');
  assert.deepEqual(sent, []);
  assert.equal(server.log.length, before, 'nothing reached the server');
  assert.equal(alice.sendFailures.length, 1, 'Discord is told the send failed');
  assert.ok(alice.notices.some((notice) => /locked, so your message was not sent/.test(notice)));

  assert.deepEqual(await alice.say(lobby, 'ENC forced encryption'), [], 'the ENC prefix is refused as well');

  // channels without encryption are not affected
  const [plain] = await alice.say(lobby, 'lunch?');
  assert.equal(plain.content, 'lunch?');
});

test('messages that arrive while locked wait, and are decrypted after unlocking', async (t) => {
  const { server, alice, secret } = await setup(t);
  const [wire] = await alice.say(secret, 'held at the door');
  const seen = alice.received.length;

  alice.utils.LockDb();
  server.send(alice, secret, wire.content);
  await settle(150);
  assert.equal(alice.received.length, seen, 'the message is held while locked');

  assert.equal(await alice.unlockAttempt('wrong'), false);
  assert.equal(alice.internals.Locked, true, 'a wrong password keeps it locked');
  assert.equal(alice.internals.Cache.dbKey, null);
  assert.equal(alice.received.length, seen);

  assert.equal(await alice.unlockAttempt(password), true);
  assert.equal(alice.internals.Locked, false);
  assert.equal(alice.internals.Active, true);
  await until(() => alice.received.length === seen + 1, 'the held message to be delivered');
  assert.equal(stripMarker(alice.lastReceived(secret).content), 'held at the door');

  // and sending works again
  const [after] = await alice.say(secret, 'back again');
  assert.match(after.content, /#s=[A-Za-z0-9_-]{22}/);
  assert.equal(stripMarker(alice.lastReceived(secret).content), 'back again');
});

test('a database without a password cannot be locked', async (t) => {
  const { alice } = await setup(t, { password: '' });
  assert.equal(alice.utils.CanLock(), false);
  assert.equal(alice.utils.LockDb(), false);
  assert.equal(alice.internals.Locked, false);
});

test('auto-lock cycles through its choices and is saved', async (t) => {
  const { alice } = await setup(t);
  assert.equal(alice.utils.GetAutoLock(), 0);
  assert.deepEqual([1, 2, 3, 4].map(() => alice.utils.CycleAutoLock()), [5, 15, 60, 0]);
  assert.equal(alice.db.autoLock, undefined);
  alice.utils.CycleAutoLock();
  await settle();
  assert.equal(alice.storage.E2EEDiscord.autoLock, 5);
});

test('stopping the plugin while locked does not unlock it', async (t) => {
  const { alice, secret } = await setup(t);
  alice.utils.LockDb();
  alice.stop();
  alice.lockScreenShown = false;
  alice.plugin.start();
  assert.equal(alice.internals.Locked, true);
  assert.equal(alice.lockScreenShown, true);
  assert.deepEqual(await alice.say(secret, 'still nothing'), []);
  assert.equal(await alice.unlockAttempt(password), true);
  const [wire] = await alice.say(secret, 'now it goes');
  assert.match(wire.content, /^[⠀-⣿]{16,}/);
});

test('at startup, before the password is entered, encrypted channels refuse plain text', async (t) => {
  const { server, alice, secret, lobby } = await setup(t);
  await settle();
  alice.stop();
  server.clients.length = 0;

  const reopened = new FakeClient(server, 'Alice', { storage: alice.storage, selectedChannel: secret });
  t.after(() => reopened.stop());
  await reopened.start({ password: null });
  await until(() => reopened.unlockAttempt, 'the unlock window');
  const before = server.log.length;

  assert.deepEqual(await reopened.say(secret, 'typed too early'), []);
  assert.equal(server.log.length, before);
  assert.equal((await reopened.say(lobby, 'hello'))[0].content, 'hello');

  assert.equal(await reopened.unlockAttempt(password), true);
  await reopened.plugin.ready;
  const [wire] = await reopened.say(secret, 'typed after unlocking');
  assert.ok(!wire.content.includes('typed'));
  assert.equal(stripMarker(reopened.lastReceived(secret).content), 'typed after unlocking');
});
