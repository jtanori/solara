import assert from "node:assert/strict";
import test from "node:test";
import { GET } from "../src/app/api/health/route";

test("liveness does not depend on the database", async () => {
  const response = GET();
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(await response.json(), { ok: true });
});
