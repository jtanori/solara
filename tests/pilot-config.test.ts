import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

/*
 * #225 / A7: the committed pilot configuration is an example only. It must carry the frozen
 * DeepSeek/OpenCode values, no key, and the TBD-105 processor marker until #105 signs the copy.
 */

const env = readFileSync(".env.pilot.example", "utf8");
const line = (key: string): string => {
  const match = new RegExp(`^${key}=(.*)$`, "m").exec(env);
  assert.ok(match, `${key} is present`);
  return match[1].trim();
};

test("both generation switches are pinned off in the example", () => {
  assert.equal(line("READINGS_GENERATION_ENABLED"), "false");
  assert.equal(line("READINGS_PAID_GENERATION_ENABLED"), "false");
});

test("the frozen DeepSeek models and thinking mode are documented", () => {
  assert.equal(line("READINGS_CHEAP_MODEL"), "deepseek-v4.1-flash");
  assert.equal(line("READINGS_STRONG_MODEL"), "deepseek-v4-pro");
  assert.equal(line("READINGS_THINKING"), "disabled");
  const prices = JSON.parse(line("READINGS_MODEL_PRICES")) as Record<string, unknown>;
  assert.ok(prices["deepseek-v4.1-flash"]);
  assert.ok(prices["deepseek-v4-pro"]);
});

test("the processor profile is provisional until #105 is signed", () => {
  const profile = JSON.parse(line("READINGS_PROCESSOR_PROFILE")) as { policyVersion?: string; id?: string };
  assert.equal(profile.policyVersion, "TBD-105");
  assert.equal(profile.id, "opencode-console");
  assert.equal(line("READINGS_PAID_PROFILE"), "paid-core-v1");
});

test("the example carries no secret", () => {
  assert.equal(line("READINGS_API_KEY"), "", "the key is intentionally empty");
  assert.doesNotMatch(env, /\bsk-[A-Za-z0-9]/);
  assert.doesNotMatch(env, /\bre_[A-Za-z0-9]{8,}/);
  assert.doesNotMatch(env, /\bBearer\s+[A-Za-z0-9._-]{8,}/);
  assert.doesNotMatch(env, /DATABASE_URL=/);
});
