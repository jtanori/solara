import assert from "node:assert/strict";
import { readdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import {
  createMailTransport,
  MailAmbiguousError,
  MailConfigurationError,
  MailDeliveryError,
  resolveMailTransportName,
} from "../src/lib/mail";

test("uses the outbox transport outside production by default", () => {
  assert.equal(resolveMailTransportName({ NODE_ENV: "development" }), "outbox");
  assert.equal(resolveMailTransportName({ NODE_ENV: "test" }), "outbox");
});

test("requires a transport in production", () => {
  assert.throws(
    () => resolveMailTransportName({ NODE_ENV: "production" }),
    MailConfigurationError,
  );
  assert.throws(
    () => createMailTransport({ NODE_ENV: "production" }),
    MailConfigurationError,
  );
});

test("rejects outbox and unknown transports in production", () => {
  assert.throws(
    () => createMailTransport({
      NODE_ENV: "production",
      MAIL_TRANSPORT: "outbox",
      MAIL_FROM: "Solara <no-reply@example.com>",
    }),
    MailConfigurationError,
  );
  assert.throws(
    () => createMailTransport({
      NODE_ENV: "production",
      MAIL_TRANSPORT: "smtp",
      MAIL_FROM: "Solara <no-reply@example.com>",
    }),
    MailConfigurationError,
  );
});

test("requires provider credentials", () => {
  assert.throws(
    () => createMailTransport({
      NODE_ENV: "production",
      MAIL_TRANSPORT: "resend",
      MAIL_FROM: "Solara <no-reply@example.com>",
    }),
    MailConfigurationError,
  );
  assert.throws(
    () => createMailTransport({
      NODE_ENV: "production",
      MAIL_TRANSPORT: "postmark",
      MAIL_FROM: "Solara <no-reply@example.com>",
    }),
    MailConfigurationError,
  );
});

test("distinguishes definitive provider rejection from an ambiguous network failure", async () => {
  const originalFetch = globalThis.fetch;
  try {
    const transport = createMailTransport({
      NODE_ENV: "production",
      MAIL_TRANSPORT: "resend",
      MAIL_FROM: "Solara <no-reply@example.com>",
      RESEND_API_KEY: "re_test",
    });

    globalThis.fetch = (async () => new Response("rejected", { status: 422 })) as typeof fetch;
    await assert.rejects(
      () => transport.send({ to: "person@example.test", subject: "Subject", text: "Body" }),
      MailDeliveryError,
    );

    globalThis.fetch = (async () => new Response("server error", { status: 503 })) as typeof fetch;
    await assert.rejects(
      () => transport.send({ to: "person@example.test", subject: "Subject", text: "Body" }),
      MailAmbiguousError,
    );

    globalThis.fetch = (async () => { throw new Error("network timeout"); }) as typeof fetch;
    await assert.rejects(
      () => transport.send({ to: "person@example.test", subject: "Subject", text: "Body" }),
      MailAmbiguousError,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("writes local messages to the outbox without logging the body", async () => {
  const directory = path.join(process.cwd(), ".mail-outbox");
  const before = new Set(await readdir(directory).catch(() => []));
  const logs: string[] = [];
  const originalLog = console.log;
  const originalInfo = console.info;
  console.log = (...args: unknown[]) => {
    logs.push(args.map(String).join(" "));
  };
  console.info = (...args: unknown[]) => {
    logs.push(args.map(String).join(" "));
  };

  try {
    const transport = createMailTransport({
      NODE_ENV: "test",
      MAIL_TRANSPORT: "outbox",
      MAIL_FROM: "Solara <no-reply@solara.local>",
    });
    assert.equal(transport.name, "outbox");
    await transport.send({
      to: "person@example.test",
      subject: "Test subject",
      text: "Verification body with secret-token",
    });

    const files = (await readdir(directory)).filter((file) => !before.has(file));
    assert.equal(files.length, 1);
    const content = await readFile(path.join(directory, files[0]), "utf8");
    assert.match(content, /To: person@example\.test/);
    assert.match(content, /Subject: Test subject/);
    assert.match(content, /secret-token/);

    const output = logs.join("\n");
    assert.doesNotMatch(output, /secret-token/);
    assert.match(output, /mail\.outbox_written/);

    await rm(path.join(directory, files[0]), { force: true });
  } finally {
    console.log = originalLog;
    console.info = originalInfo;
  }
});
