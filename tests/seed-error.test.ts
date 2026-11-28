import assert from "node:assert/strict";
import test from "node:test";
import { z } from "zod";
import { describeSeedError, SeedError } from "../scripts/lib/seed-error";

test("a seed failure keeps the tool's own message", () => {
  assert.equal(describeSeedError(new SeedError("report has no case rich-es")), "report has no case rich-es");
});

test("report parsing is named without echoing the report", () => {
  const parsed = z.object({ samples: z.array(z.string()) }).safeParse({ samples: [42] });
  assert.equal(parsed.success, false);
  if (parsed.success) return;
  const message = describeSeedError(parsed.error);
  assert.equal(message, "invalid_report (1 issue)");
  assert.ok(!message.includes("42"), "issue values are never printed");

  const parseError = (() => {
    try { JSON.parse("{not json"); } catch (error) { return error; }
    throw new Error("expected JSON.parse to throw");
  })();
  assert.equal(describeSeedError(parseError), "invalid_report (invalid JSON)");
});

test("a database error keeps the SQLSTATE and drops the driver detail", () => {
  const duplicate = Object.assign(
    new Error("duplicate key value violates unique constraint \"users_email_unique\" Key (email)=(a@b.c) already exists."),
    { code: "23505", severity: "ERROR", detail: "Key (email)=(a@b.c) already exists." },
  );
  const message = describeSeedError(duplicate);
  assert.equal(message, "database_error (23505)");
  assert.ok(!message.includes("a@b.c"));

  // Drizzle wraps the pg error; the SQLSTATE and severity are on the cause.
  const wrapped = new Error("query failed for postgres://user:pass@host/db", {
    cause: { code: "23505", severity: "ERROR", detail: "Key (email)=(a@b.c) already exists." },
  });
  assert.equal(describeSeedError(wrapped), "database_error (23505)");
  assert.ok(!describeSeedError(wrapped).includes("postgres://"));
});

test("a filesystem or connection failure is not called a database error", () => {
  const missing = Object.assign(new Error("ENOENT: no such file or directory, open '/tmp/secret/report.json'"), {
    code: "ENOENT", syscall: "open", path: "/tmp/secret/report.json",
  });
  assert.equal(describeSeedError(missing), "system_error (ENOENT)");
  assert.ok(!describeSeedError(missing).includes("/tmp"));

  // Five uppercase letters, but not a SQLSTATE.
  const brokenPipe = Object.assign(new Error("write EPIPE"), { code: "EPIPE", syscall: "write" });
  assert.equal(describeSeedError(brokenPipe), "system_error (EPIPE)");
});

test("an unknown failure never prints its own message", () => {
  assert.equal(describeSeedError(new Error("postgres://user:pass@host/db")), "unexpected_error");
  assert.equal(describeSeedError("database password is hunter2"), "unexpected_error");
});
