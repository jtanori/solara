import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";

const probe = `
import { GET } from "./src/app/api/health/route.ts";

const response = GET();
const body = await response.json();
if (response.status !== 200) {
  console.error("unexpected status", response.status);
  process.exit(1);
}
if (response.headers.get("cache-control") !== "no-store") {
  console.error("missing no-store", response.headers.get("cache-control"));
  process.exit(1);
}
if (body.ok !== true) {
  console.error("unexpected body", JSON.stringify(body));
  process.exit(1);
}
console.log("ok");
`;

test("liveness loads and answers with no database configuration", () => {
  const result = spawnSync(path.resolve("node_modules/.bin/tsx"), ["--input-type=module", "-e", probe], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: {
      ...process.env,
      DATABASE_URL: "",
      DATABASE_URL_DIRECT: "",
      NODE_ENV: "test",
    },
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /ok/);
});
