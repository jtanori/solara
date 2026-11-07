import assert from "node:assert/strict";
import test from "node:test";
import { hashPassword, verifyPassword } from "../src/lib/passwords";

test("hashPassword produces salt:hash with expected format", () => {
  const hash = hashPassword("correct-horse-battery");
  const parts = hash.split(":");
  assert.equal(parts.length, 2);
  assert.equal(parts[0].length, 32, "salt should be 16 bytes hex = 32 chars");
  assert.equal(parts[1].length, 128, "hash should be 64 bytes hex = 128 chars");
  assert.match(hash, /^[0-9a-f]{32}:[0-9a-f]{128}$/);
});

test("hashPassword uses random salt — same password yields different hashes", () => {
  const a = hashPassword("same-password");
  const b = hashPassword("same-password");
  assert.notEqual(a, b);
  assert.equal(verifyPassword("same-password", a), true);
  assert.equal(verifyPassword("same-password", b), true);
});

test("verifyPassword returns true for correct password", () => {
  const password = "10-char-min!";
  const hash = hashPassword(password);
  assert.equal(verifyPassword(password, hash), true);
});

test("verifyPassword returns false for wrong password", () => {
  const hash = hashPassword("correct-password");
  assert.equal(verifyPassword("wrong-password", hash), false);
  assert.equal(verifyPassword("", hash), false);
  assert.equal(verifyPassword("CORRECT-PASSWORD", hash), false);
});

test("verifyPassword rejects malformed stored values", () => {
  assert.equal(verifyPassword("password", ""), false);
  assert.equal(verifyPassword("password", "not-a-hash"), false);
  assert.equal(verifyPassword("password", "salt:short"), false);
  assert.equal(verifyPassword("password", "onlysalt:"), false);
  assert.equal(verifyPassword("password", ":onlyhash01234567890123456789abcdef01234567890123456789abcdef01234567890123456789abcdef01234567890123456789abcdef0123456789012345"), false);
  // No colon at all
  assert.equal(verifyPassword("password", "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789"), false);
  // Hash length wrong (127 instead of 128) and invalid hex
  const hash = hashPassword("test");
  const [salt] = hash.split(":");
  assert.equal(verifyPassword("test", `${salt}:${"a".repeat(127)}`), false);
  assert.equal(verifyPassword("test", `${salt}:${"g".repeat(128)}`), false); // explicit hex validation rejects non-hex
});

test("handles unicode and long passwords", () => {
  const unicode = "pässwörd🔑—münchen-10-chars!";
  const hash = hashPassword(unicode);
  assert.equal(verifyPassword(unicode, hash), true);
  assert.equal(verifyPassword(unicode + "x", hash), false);

  const long = "a".repeat(128);
  const longHash = hashPassword(long);
  assert.equal(verifyPassword(long, longHash), true);
  assert.equal(verifyPassword("a".repeat(127), longHash), false);
});
