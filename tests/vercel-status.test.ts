import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";

function parse(payload: unknown, context = "Vercel") {
  return spawnSync(process.execPath, [path.resolve("scripts/lib/vercel-status.mjs"), context], {
    encoding: "utf8",
    input: typeof payload === "string" ? payload : JSON.stringify(payload),
  });
}

test("selects the latest matching Vercel status", () => {
  const result = parse({
    statuses: [
      { context: "Other", state: "failure", created_at: "2026-01-01T00:00:03Z" },
      { context: "Vercel", state: "success", target_url: "https://vercel.example/new", created_at: "2026-01-01T00:00:02Z" },
      { context: "Vercel", state: "pending", created_at: "2026-01-01T00:00:01Z" },
    ],
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "success\thttps://vercel.example/new\n");
});

test("ignores other contexts", () => {
  const result = parse({ statuses: [{ context: "GitGuardian", state: "success" }] });
  assert.equal(result.status, 0);
  assert.equal(result.stdout, "");
});

test("returns nothing for an empty or malformed payload", () => {
  assert.equal(parse({ statuses: [] }).stdout, "");
  assert.equal(parse("not json").stdout, "");
});

test("handles a missing target URL", () => {
  const result = parse({ statuses: [{ context: "Vercel", state: "success" }] });
  assert.equal(result.stdout, "success\t\n");
});
