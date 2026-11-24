import assert from "node:assert/strict";
import test from "node:test";
import { canonicalAppUrl } from "../src/lib/app-url";
import { MailConfigurationError } from "../src/lib/mail";

test("uses localhost only outside hosted environments", () => {
  assert.equal(canonicalAppUrl(undefined, { NODE_ENV: "development" }), "http://localhost:3000");
  assert.equal(canonicalAppUrl(undefined, { NODE_ENV: "test" }), "http://localhost:3000");
});

test("requires a canonical HTTPS origin in production", () => {
  assert.throws(() => canonicalAppUrl(undefined, { NODE_ENV: "production" }), MailConfigurationError);
  assert.throws(() => canonicalAppUrl("http://solara.example", { NODE_ENV: "production" }), MailConfigurationError);
  assert.throws(() => canonicalAppUrl("https://solara.example/path", { NODE_ENV: "production" }), MailConfigurationError);
  assert.equal(canonicalAppUrl("https://solara.example", { NODE_ENV: "production" }), "https://solara.example");
});
