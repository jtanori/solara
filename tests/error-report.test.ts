import assert from "node:assert/strict";
import test from "node:test";
import {
  safeErrorCategory,
  reportServerError,
} from "../src/lib/error-report";
import {
  MailAmbiguousError,
  MailConfigurationError,
  MailDeliveryError,
} from "../src/lib/mail";

test("classifies errors without reading their messages", () => {
  const dbError = Object.assign(new Error("insert into users values ('victim@example.test', 'hash')"), { code: "23505" });
  assert.equal(safeErrorCategory(dbError), "db_23505");
  assert.equal(safeErrorCategory(new MailConfigurationError("missing key")), "mail_configuration");
  assert.equal(safeErrorCategory(new MailDeliveryError("rejected")), "mail_delivery");
  assert.equal(safeErrorCategory(new MailAmbiguousError("timeout")), "mail_ambiguous");
  assert.equal(safeErrorCategory(new Error("secret")), "unknown");
});

test("log output contains no error message or credential material", () => {
  const logs: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => { logs.push(args.map(String).join(" ")); };

  try {
    reportServerError("auth.test_failed", Object.assign(
      new Error("users.email='victim@example.test' password_hash='salt:hash'"),
      { code: "23505" },
    ));
  } finally {
    console.error = original;
  }

  const output = logs.join("\n");
  assert.match(output, /auth\.test_failed/);
  assert.match(output, /db_23505/);
  assert.doesNotMatch(output, /victim@example\.test/);
  assert.doesNotMatch(output, /salt:hash/);
});
