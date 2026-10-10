// The key vault: password protection of the database, and the upgrade from the 2.x format
import test from 'node:test';
import assert from 'node:assert/strict';
import { createCipheriv, createDecipheriv, createHash, pbkdf2Sync, randomBytes, webcrypto } from 'node:crypto';
import { FakeServer, FakeClient, settle, stripMarker } from './helpers/harness.mjs';

const sha512 = (data) => createHash('sha512').update(data).digest();
const cbcEncrypt = (key, data) => {
  const iv = randomBytes(16);
  const cipher = createCipheriv('aes-256-cbc', key, iv);
  return Buffer.concat([iv, cipher.update(data), cipher.final()]);
};
const cbcDecrypt = (key, data) => {
  const decipher = createDecipheriv('aes-256-cbc', key, data.subarray(0, 16));
  return Buffer.concat([decipher.update(data.subarray(16)), decipher.final()]);
};

/** PROTOCOL.md "Database export", written from the spec: returns the vault key if the password fits */
function referenceVaultKey(db, password) {
  const out = pbkdf2Sync(password, Buffer.from(db.kdfSalt, 'base64'), db.kdfIterations, 48, 'sha512');
  if (out.subarray(32, 48).toString('base64') !== db.dbPasswordHash) return null;
  return out.subarray(0, 32);
}

/** A password-protected database exactly as E2EE-Discord 2.0.2 (and SimpleDiscordCrypt) stored it */
async function makeLegacyDatabase(password) {
  const dbPasswordSalt = randomBytes(4).readUInt32LE();
  const dbKeySalt = randomBytes(4).readUInt32LE();
  const dbKey = sha512(password + dbKeySalt).subarray(0, 32);
  const personalKey = randomBytes(32);
  const groupKey = randomBytes(32);
  const hashOf = (key) => sha512(key).subarray(0, 16).toString('base64');
  const dh = await webcrypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-521' }, true, ['deriveBits']);
  const now = Date.now();
  const entry = (key, t, d) => ({ t, d, r: now, l: now, h: t > 1 ? 1 : 0, k: cbcEncrypt(dbKey, key).toString('base64') });
  return {
    personalKey,
    groupKey,
    db: {
      isEncrypted: true,
      dbPasswordSalt,
      dbKeySalt,
      dbPasswordHash: sha512(password + dbPasswordSalt).subarray(0, 16).toString('base64'),
      keys: {
        [hashOf(personalKey)]: entry(personalKey, 3, '#Your personal key#'),
        [hashOf(groupKey)]: entry(groupKey, 1, 'Old group'),
      },
      channels: {},
      personalKeyHash: hashOf(personalKey),
      dhPublicKey: Buffer.from(await webcrypto.subtle.exportKey('raw', dh.publicKey)).toString('base64'),
      dhPrivateKey: cbcEncrypt(dbKey, Buffer.from(await webcrypto.subtle.exportKey('pkcs8', dh.privateKey))).toString('base64'),
      autoKeyExchange: 'ask',
    },
  };
}

test('a new password-protected database uses PBKDF2 and wraps every key', async (t) => {
  const server = new FakeServer();
  const alice = await new FakeClient(server, 'Alice').start({ password: 'correct horse battery' });
  t.after(() => alice.stop());
  await settle();

  const db = alice.storage.E2EEDiscord;
  assert.equal(db.isEncrypted, true);
  assert.equal(db.kdf, 'PBKDF2-SHA512');
  assert.equal(db.kdfIterations, 600000);
  assert.equal(Buffer.from(db.kdfSalt, 'base64').length, 16);
  for (const legacyField of ['dbPasswordSalt', 'dbKeySalt']) assert.ok(!(legacyField in db), `${legacyField} is gone`);

  assert.equal(referenceVaultKey(db, 'wrong'), null);
  const vaultKey = referenceVaultKey(db, 'correct horse battery');
  assert.ok(vaultKey, 'the stored check value matches PBKDF2 of the password');

  const personal = cbcDecrypt(vaultKey, Buffer.from(db.keys[db.personalKeyHash].k, 'base64'));
  assert.equal(personal.length, 32);
  assert.equal(sha512(personal).subarray(0, 16).toString('base64'), db.personalKeyHash);
  assert.ok(cbcDecrypt(vaultKey, Buffer.from(db.dhPrivateKey, 'base64')).length > 100, 'the ECDH private key is wrapped too');
});

test('reopening asks for the password: wrong ones are refused, the right one restores everything', async (t) => {
  const server = new FakeServer();
  const channel = server.guildChannel();
  const first = await new FakeClient(server, 'Alice').start({ password: 'hunter2!' });
  first.select(channel);
  first.utils.ToggleCurrentChannelEncrypt();
  const [wire] = await first.say(channel, 'remember me');
  await settle();
  first.stop();
  server.clients.length = 0;

  const second = new FakeClient(server, 'Alice', { storage: first.storage, selectedChannel: channel });
  t.after(() => second.stop());
  await second.start({ password: null });
  await settle();
  assert.equal(second.internals.Active, false, 'inactive until unlocked');

  assert.equal(await second.unlockAttempt('hunter2'), false);
  assert.equal(await second.unlockAttempt(''), false);
  assert.equal(second.internals.Active, false);
  assert.equal(await second.unlockAttempt('hunter2!'), true);
  await second.plugin.ready;

  await second.receive({ ...structuredClone(wire), id: '424242' });
  assert.equal(stripMarker(second.lastReceived(channel).content), 'remember me');
});

test('a 2.x database is unlocked with its old password and upgraded in place', async (t) => {
  const { db: legacy, personalKey, groupKey } = await makeLegacyDatabase('pässwörd ✓');
  const server = new FakeServer();
  const channel = server.guildChannel();
  const alice = new FakeClient(server, 'Alice', { storage: { E2EEDiscord: structuredClone(legacy) }, selectedChannel: channel });
  t.after(() => alice.stop());
  await alice.start({ password: null });
  await settle();

  assert.equal(await alice.unlockAttempt('pässwörd'), false, 'a wrong password does not unlock');
  assert.equal(alice.db.kdf, undefined, '…and does not touch the database');

  assert.equal(await alice.unlockAttempt('pässwörd ✓'), true);
  await alice.plugin.ready;
  await settle();

  const db = alice.storage.E2EEDiscord;
  assert.equal(db.kdf, 'PBKDF2-SHA512');
  assert.equal(db.kdfIterations, 600000);
  for (const legacyField of ['dbPasswordSalt', 'dbKeySalt']) assert.ok(!(legacyField in db), `${legacyField} is gone`);
  assert.notEqual(db.dbPasswordHash, legacy.dbPasswordHash, 'the fast password hash is no longer stored');

  const vaultKey = referenceVaultKey(db, 'pässwörd ✓');
  assert.ok(vaultKey);
  assert.deepEqual(Object.keys(db.keys).sort(), Object.keys(legacy.keys).sort(), 'no key was lost');
  assert.ok(cbcDecrypt(vaultKey, Buffer.from(db.keys[db.personalKeyHash].k, 'base64')).equals(personalKey));
  const groupHash = Object.keys(db.keys).find((hash) => hash !== db.personalKeyHash);
  assert.ok(cbcDecrypt(vaultKey, Buffer.from(db.keys[groupHash].k, 'base64')).equals(groupKey));
  assert.equal(db.keys[groupHash].d, 'Old group', 'key names are kept');

  // the upgraded vault works: encrypt and read back a message
  alice.utils.ToggleCurrentChannelEncrypt();
  await alice.say(channel, 'still works');
  assert.equal(stripMarker(alice.lastReceived(channel).content), 'still works');

  // …and the private key still loads, so key exchanges keep working
  assert.ok(await alice.utils.ReadDhKey());
  assert.ok(alice.notices.some((notice) => notice.includes('3.0')), 'the "what is new" notice is shown once');
});

test('changing and removing the password re-wraps the keys', async (t) => {
  const server = new FakeServer();
  const alice = await new FakeClient(server, 'Alice').start({ password: 'first' });
  t.after(() => alice.stop());
  const personalHash = alice.db.personalKeyHash;
  const original = Buffer.from(await alice.utils.GetKeyBytesByHash(personalHash));

  await alice.utils.SetDbPassword('second');
  assert.equal(await alice.utils.CheckDbPassword(alice.db, 'first'), null);
  assert.ok(await alice.utils.CheckDbPassword(alice.db, 'second'));
  assert.ok(Buffer.from(await alice.utils.GetKeyBytesByHash(personalHash)).equals(original));
  assert.ok(cbcDecrypt(referenceVaultKey(alice.db, 'second'), Buffer.from(alice.db.keys[personalHash].k, 'base64')).equals(original));

  await alice.utils.SetDbPassword('');
  assert.equal(alice.db.isEncrypted, false);
  for (const field of ['kdf', 'kdfIterations', 'kdfSalt', 'dbPasswordHash']) assert.ok(!(field in alice.db), `${field} is gone`);
  assert.ok(Buffer.from(alice.db.keys[personalHash].k, 'base64').equals(original), 'keys are stored unwrapped');
  assert.equal(alice.utils.CanLock(), false, 'nothing to lock without a password');

  await alice.utils.SetDbPassword('third');
  assert.ok(cbcDecrypt(referenceVaultKey(alice.db, 'third'), Buffer.from(alice.db.keys[personalHash].k, 'base64')).equals(original));
});

test('a database from a newer, unknown vault format is refused instead of guessed at', async (t) => {
  const server = new FakeServer();
  const alice = await new FakeClient(server, 'Alice').start({ password: 'pw' });
  t.after(() => alice.stop());
  const future = { ...alice.db, kdf: 'ARGON2ID' };
  await assert.rejects(alice.utils.CheckDbPassword(future, 'pw'), /newer version/);
});

test('a database without a password loads as before', async (t) => {
  const server = new FakeServer();
  const channel = server.guildChannel();
  const first = await new FakeClient(server, 'Alice').start();
  await settle();
  first.stop();
  server.clients.length = 0;
  const stored = structuredClone(first.storage);
  delete stored.E2EEDiscord.seenVersion; // as written by 2.x

  const second = await new FakeClient(server, 'Alice', { storage: stored, selectedChannel: channel }).start({ password: null });
  t.after(() => second.stop());
  assert.equal(second.internals.Active, true);
  assert.equal(second.db.isEncrypted, false);
  assert.equal(second.db.kdf, undefined);
  second.utils.ToggleCurrentChannelEncrypt();
  await second.say(channel, 'no password needed');
  assert.equal(stripMarker(second.lastReceived(channel).content), 'no password needed');
});
