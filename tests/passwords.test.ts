import assert from "node:assert/strict";
import test from "node:test";
import { hashPassword, verifyPassword } from "../src/lib/passwords";

test("hashPassword produces salt:hash with expected format", async () => {
  const hash = await hashPassword("correct-horse-battery");
  const parts = hash.split(":");
  assert.equal(parts.length, 2);
  assert.equal(parts[0].length, 32, "salt should be 16 bytes hex = 32 chars");
  assert.equal(parts[1].length, 128, "hash should be 64 bytes hex = 128 chars");
  assert.match(hash, /^[0-9a-f]{32}:[0-9a-f]{128}$/);
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

test("verifyPassword rejects malformed stored values", async () => {
  assert.equal(await verifyPassword("password", ""), false);
  assert.equal(await verifyPassword("password", "not-a-hash"), false);
  assert.equal(await verifyPassword("password", "salt:short"), false);
  assert.equal(await verifyPassword("password", "onlysalt:"), false);
  assert.equal(await verifyPassword("password", ":onlyhash01234567890123456789abcdef01234567890123456789abcdef01234567890123456789abcdef01234567890123456789abcdef0123456789012345"), false);
  assert.equal(await verifyPassword("password", "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789"), false);
  const hash = await hashPassword("test");
  const [salt] = hash.split(":");
  assert.equal(await verifyPassword("test", `${salt}:${"a".repeat(127)}`), false);
  assert.equal(await verifyPassword("test", `${salt}:${"g".repeat(128)}`), false);
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
