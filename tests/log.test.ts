import assert from "node:assert/strict";
import test from "node:test";
import { randomBytes } from "node:crypto";
import { log, redactString, redactValue, safeError } from "../src/lib/log";

test("redacts common credential and PII strings", () => {
  const value = [
    "person@example.test",
    "postgresql://user:pass@db.example/app",
    "Bearer abc.def",
    "sk_test_123456",
    "whsec_123456",
    "re_12345678",
    "?token=abcdef&email=person@example.test",
    "a".repeat(64),
  ].join(" ");
  const redacted = redactString(value);
  assert.doesNotMatch(redacted, /person@example/);
  assert.doesNotMatch(redacted, /postgresql:\/\//);
  assert.doesNotMatch(redacted, /Bearer abc/);
  assert.doesNotMatch(redacted, /sk_test_/);
  assert.doesNotMatch(redacted, /whsec_/);
  assert.doesNotMatch(redacted, /re_123/);
  assert.doesNotMatch(redacted, /abcdef/);
  assert.doesNotMatch(redacted, /a{64}/);
});

test("redacts 43-character opaque tokens but preserves UUIDs", () => {
  const token = randomBytes(32).toString("base64url");
  assert.equal(token.length, 43);
  const redacted = redactString(`verification token ${token}`);
  assert.doesNotMatch(redacted, new RegExp(token));
  assert.match(redacted, /\[opaque\]/);

  const userId = "11111111-1111-4111-8111-111111111111";
  assert.match(redactString(`user ${userId}`), new RegExp(userId));
});

test("redacts sensitive object keys recursively", () => {
  const value = redactValue({
    email: "person@example.test",
    birthDate: "1984-05-16",
    nested: { token: "secret", safe: "hello" },
  });
  assert.deepEqual(value, {
    email: "[redacted]",
    birthDate: "[redacted]",
    nested: { token: "[redacted]", safe: "hello" },
  });
});

test("database errors never expose Drizzle query parameters", () => {
  const error = Object.assign(
    new Error("insert into readings values ('1984-05-16', 'person@example.test')"),
    { code: "23505" },
  );
  assert.deepEqual(safeError(error), {
    name: "Error",
    code: "23505",
    message: "database error",
    stackHash: safeError(error).stackHash,
  });
  assert.doesNotMatch(JSON.stringify(safeError(error)), /1984-05-16|person@example/);
});

test("log lines include request id and redacted fields", () => {
  const lines: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => { lines.push(args.map(String).join(" ")); };
  try {
    log.error("readings.save_failed", {
      requestId: "req-123",
      route: "/api/readings",
      userId: "11111111-1111-4111-8111-111111111111",
      input: { birthDate: "1984-05-16", birthPlace: "Mexicali" },
      error: Object.assign(new Error("insert failed for person@example.test"), { code: "23505" }),
    });
  } finally {
    console.error = original;
  }
  const line = lines.join("\n");
  assert.match(line, /req-123/);
  assert.match(line, /readings\.save_failed/);
  assert.doesNotMatch(line, /1984-05-16|Mexicali|person@example/);
});
