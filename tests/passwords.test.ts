import assert from "node:assert/strict";
import { scrypt } from "node:crypto";
import test from "node:test";
import { promisify } from "node:util";
import {
  CURRENT_SCRYPT_PARAMS,
  hashPassword,
  needsRehash,
  verifyPassword,
} from "../src/lib/passwords";

const scryptAsync = promisify(scrypt) as (
  password: string,
  salt: string,
  keylen: number,
  options?: { N: number; r: number; p: number; maxmem?: number },
) => Promise<Buffer>;

/**
 * Build a hash in the *pre-S8* format using only node:crypto, so the legacy
 * compatibility tests do not depend on the module under test to produce their
 * own input. This is what a row created before this change actually contains.
 */
async function legacyHash(password: string, salt = "a".repeat(32)): Promise<string> {
  const hash = await scryptAsync(password, salt, 64);
  return `${salt}:${hash.toString("hex")}`;
}

test("hashPassword produces scrypt$N$r$p$salt$hash", async () => {
  const hash = await hashPassword("correct-horse-battery");
  const parts = hash.split("$");
  assert.equal(parts.length, 6, "scrypt$N$r$p$salt$hash");
  assert.equal(parts[0], "scrypt");
  assert.equal(Number(parts[1]), CURRENT_SCRYPT_PARAMS.N);
  assert.equal(Number(parts[2]), CURRENT_SCRYPT_PARAMS.r);
  assert.equal(Number(parts[3]), CURRENT_SCRYPT_PARAMS.p);
  assert.match(parts[4], /^[0-9a-f]{32}$/, "salt is 16 bytes hex");
  assert.match(parts[5], /^[0-9a-f]{128}$/, "hash is 64 bytes hex");
  assert.match(hash, /^scrypt\$16384\$8\$1\$[0-9a-f]{32}\$[0-9a-f]{128}$/);
});

test("the recorded parameters survive a round trip — the whole point of S8", async () => {
  // A hash written today must say what cost it used, so a future cost bump can
  // tell old hashes from new ones without guessing.
  const hash = await hashPassword("readable-parameters");
  const [, rawN, rawR, rawP] = hash.split("$");
  assert.deepEqual(
    { N: Number(rawN), r: Number(rawR), p: Number(rawP) },
    CURRENT_SCRYPT_PARAMS,
  );
  assert.equal(needsRehash(hash), false, "a fresh hash is never behind");
});

test("hashPassword uses random salt — same password yields different hashes", async () => {
  const a = await hashPassword("same-password");
  const b = await hashPassword("same-password");
  assert.notEqual(a, b);
  assert.equal(await verifyPassword("same-password", a), true);
  assert.equal(await verifyPassword("same-password", b), true);
});

test("verifyPassword returns true for correct password", async () => {
  const password = "10-char-min!";
  const hash = await hashPassword(password);
  assert.equal(await verifyPassword(password, hash), true);
});

test("verifyPassword returns false for wrong password", async () => {
  const hash = await hashPassword("correct-password");
  assert.equal(await verifyPassword("wrong-password", hash), false);
  assert.equal(await verifyPassword("", hash), false);
  assert.equal(await verifyPassword("CORRECT-PASSWORD", hash), false);
});

test("legacy salt:hash still verifies — existing accounts keep working", async () => {
  // The compatibility promise. Every account created before this change stores
  // this format, and there is no recovery path if it stops verifying.
  const password = "legacy-account-password";
  const stored = await legacyHash(password);
  assert.match(stored, /^[0-9a-f]{32}:[0-9a-f]{128}$/);
  assert.equal(await verifyPassword(password, stored), true);
  assert.equal(await verifyPassword("not-the-password", stored), false);
});

test("needsRehash flags legacy hashes and leaves current ones alone", async () => {
  const legacy = await legacyHash("some-legacy-password");
  assert.equal(needsRehash(legacy), true, "legacy format should be upgraded");
  assert.equal(needsRehash(await hashPassword("current-password")), false);

  // A v2 hash recorded at a *lower* cost than today's should also be upgraded.
  const weaker = await scryptAsync("weaker-password", "b".repeat(32), 64, { N: 4096, r: 8, p: 1 });
  const weakerHash = `scrypt$4096$8$1$${"b".repeat(32)}$${weaker.toString("hex")}`;
  assert.equal(await verifyPassword("weaker-password", weakerHash), true);
  assert.equal(needsRehash(weakerHash), true, "below current cost");
});

test("a hash recorded at higher cost still verifies and is not downgraded", async () => {
  // Forward compatibility: if the cost is raised, hashes above it must keep
  // working and must not be re-hashed back down.
  const stronger = await scryptAsync("strong-password", "c".repeat(32), 64, {
    N: 32768,
    r: 8,
    p: 1,
    maxmem: 128 * 32768 * 8 * 2,
  });
  const strongerHash = `scrypt$32768$8$1$${"c".repeat(32)}$${stronger.toString("hex")}`;
  assert.equal(await verifyPassword("strong-password", strongerHash), true);
  assert.equal(needsRehash(strongerHash), false);
});

test("verifyPassword rejects malformed stored values", async () => {
  const valid = await hashPassword("test");
  const [, , , , salt, hash] = valid.split("$");
  const cases = [
    "",
    "not-a-hash",
    "salt:short",
    "onlysalt:",
    `:${"a".repeat(128)}`,
    "a".repeat(32) + "a".repeat(128),
    `${salt}:${"a".repeat(127)}`,
    `${salt}:${"g".repeat(128)}`,
    // v2 with the wrong number of fields
    `scrypt$16384$8$1$${salt}`,
    `scrypt$16384$8$${salt}$${hash}`,
    `scrypt$16384$8$1$${salt}$${hash}$extra`,
    // Non-power-of-two N is not a valid scrypt parameter
    `scrypt$16383$8$1$${salt}$${hash}`,
    // N/r/p must be positive integers
    `scrypt$0$8$1$${salt}$${hash}`,
    `scrypt$-16384$8$1$${salt}$${hash}`,
    `scrypt$abc$8$1$${salt}$${hash}`,
    `scrypt$16384.5$8$1$${salt}$${hash}`,
    // Bad salt/hash encodings
    `scrypt$16384$8$1$${salt}$${"g".repeat(128)}`,
    `scrypt$16384$8$1$${"d".repeat(31)}$${hash}`,
    // Truncation
    valid.slice(0, valid.length - 1),
    valid.slice(0, 20),
  ];
  for (const stored of cases) {
    assert.equal(await verifyPassword("test", stored), false, `should reject: ${stored.slice(0, 40)}`);
  }
});

test("verifyPassword refuses parameters that would exhaust memory", async () => {
  // Anything that can read a hash row must not be able to make this process
  // allocate gigabytes by planting a huge N. scrypt memory is ~128*N*r bytes.
  const salt = "e".repeat(32);
  const hash = "f".repeat(128);
  for (const stored of [
    `scrypt$1048577$8$1$${salt}$${hash}`, // N above the ceiling
    `scrypt$99999999$8$1$${salt}$${hash}`, // N absurdly large
    `scrypt$16384$33$1$${salt}$${hash}`, // r above the ceiling
    `scrypt$16384$8$17$${salt}$${hash}`, // p above the ceiling
  ]) {
    assert.equal(await verifyPassword("anything", stored), false);
  }
});

test("needsRehash never throws on garbage", async () => {
  for (const stored of ["", "garbage", "scrypt$", "scrypt$1$2$3$x$y", ":", "a:b:c"]) {
    assert.equal(needsRehash(stored), false);
  }
  assert.equal(needsRehash(await legacyHash("x")), true);
});

test("handles unicode and long passwords", async () => {
  const unicode = "pässwörd🔑—münchen-10-chars!";
  const hash = await hashPassword(unicode);
  assert.equal(await verifyPassword(unicode, hash), true);
  assert.equal(await verifyPassword(unicode + "x", hash), false);

  const long = "a".repeat(128);
  const longHash = await hashPassword(long);
  assert.equal(await verifyPassword(long, longHash), true);
  assert.equal(await verifyPassword("a".repeat(127), longHash), false);

  // The same password must produce the same result through the legacy path.
  const legacy = await legacyHash(unicode);
  assert.equal(await verifyPassword(unicode, legacy), true);
});

test("concurrent hashes do not share salts or results", async () => {
  const [a, b, c] = await Promise.all([
    hashPassword("concurrent-password"),
    hashPassword("concurrent-password"),
    hashPassword("concurrent-password"),
  ]);
  assert.equal(new Set([a, b, c]).size, 3);
  assert.equal(await verifyPassword("concurrent-password", a), true);
  assert.equal(await verifyPassword("concurrent-password", b), true);
  assert.equal(await verifyPassword("concurrent-password", c), true);
});
