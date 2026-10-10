// The Android plugin (aliucord/, Kotlin) spells out HKDF and PBKDF2 by hand from HMAC. These tests
// run the same steps in JavaScript and compare them with the standard implementations, so a mistake
// in the construction shows up here. They do not compile or run the Kotlin itself.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, hkdfSync, pbkdf2Sync, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';

const hmac = (algorithm, key, data) => createHmac(algorithm, key).update(data).digest();

// Protocol.seal() in Protocol.kt
function sealLikeAndroid(key, payload) {
  const extracted = hmac('sha256', Buffer.alloc(32), key);
  const macKey = hmac('sha256', extracted, Buffer.concat([Buffer.from('E2EE-Discord seal v1'), Buffer.from([1])]));
  return hmac('sha256', macKey, payload).subarray(0, 16).toString('base64url');
}

// Protocol.pbkdf2Sha512() in Protocol.kt
function pbkdf2LikeAndroid(password, salt, iterations, length) {
  let block = hmac('sha512', password, Buffer.concat([salt, Buffer.from([0, 0, 0, 1])]));
  const out = Buffer.from(block);
  for (let i = 1; i < iterations; i++) {
    block = hmac('sha512', password, block);
    for (let j = 0; j < out.length; j++) out[j] ^= block[j];
  }
  return out.subarray(0, length);
}

test('the hand-written HKDF + HMAC seal equals the standard one', () => {
  for (let round = 0; round < 20; round++) {
    const key = randomBytes(32);
    const payload = randomBytes(16 + 16 * round);
    const macKey = Buffer.from(hkdfSync('sha256', key, Buffer.alloc(0), 'E2EE-Discord seal v1', 32));
    const expected = hmac('sha256', macKey, payload).subarray(0, 16).toString('base64url');
    assert.equal(sealLikeAndroid(key, payload), expected);
    assert.equal(expected.length, 22);
  }
});

test('the hand-written PBKDF2 equals the standard one', () => {
  for (const [password, iterations] of [['pw', 1], ['pässwörd ✓', 2], ['correct horse battery staple', 1000], ['x'.repeat(200), 37]]) {
    const salt = randomBytes(16);
    const expected = pbkdf2Sync(password, salt, iterations, 48, 'sha512');
    assert.ok(pbkdf2LikeAndroid(Buffer.from(password, 'utf8'), salt, iterations, 48).equals(expected), `${iterations} iterations`);
  }
});

test('both platforms use the same constants', () => {
  const kotlin = readFileSync(new URL('../aliucord/plugins/E2EEDiscord/src/main/kotlin/st/xo/e2eediscord/Protocol.kt', import.meta.url), 'utf8');
  const database = readFileSync(new URL('../aliucord/plugins/E2EEDiscord/src/main/kotlin/st/xo/e2eediscord/KeyDatabase.kt', import.meta.url), 'utf8');
  const core = readFileSync(new URL('../src/core.js', import.meta.url), 'utf8');

  const info = /const SealInfo = '([^']+)'/.exec(core)[1];
  assert.ok(kotlin.includes(`"${info}".toByteArray`), 'seal info string');
  const kdf = /const VaultKdfName = '([^']+)'/.exec(core)[1];
  assert.ok(database.includes(`"${kdf}"`), 'vault KDF name');

  // the seal pattern is written once per language; they must accept the same text
  const jsSeal = /const sealRegex = \/(.+)\/i;/.exec(core)[1];
  const kotlinSeal = /sealPattern: Pattern = Pattern\.compile\(\s*"""(.+)"""/.exec(kotlin)[1];
  assert.equal(kotlinSeal, jsSeal);
});
