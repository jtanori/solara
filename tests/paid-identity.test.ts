import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { canonicalHash } from "../src/readings/policy";
import { identityEnvironment, reverseObjects } from "./helpers/paid-identity";
import golden from "./fixtures/readings/paid-snapshot-hashes-v0.json";

const sha = (value: string) => createHash("sha256").update(value).digest("hex");
test("canonical JSON uses specified UTF-16 key order, nested normalization and significant array order", () => {
  const value = { "2": "two", "10": "ten", index: 2, Index: 1, nested: { z: 2, A: 1 }, array: [{ b: 2, a: 1 }, 3], absent: undefined };
  const expected = '{"10":"ten","2":"two","Index":1,"array":[{"a":1,"b":2},3],"index":2,"nested":{"A":1,"z":2}}';
  assert.equal(canonicalHash(value), sha(expected));
  assert.equal(canonicalHash(reverseObjects(value)), sha(expected));
  assert.notEqual(canonicalHash([1, 2]), canonicalHash([2, 1]));
  assert.notEqual(canonicalHash({ "é": 1 }), canonicalHash({ "e\u0301": 1 }), "no Unicode normalization is implied");
  assert.equal(canonicalHash({ "😀": 1, "\ue000": 2 }), sha('{"😀":1,"\ue000":2}'), "UTF-16 code units, not code points");
});

test("paid identity is identical across English/Turkish process locales and reversed model/alias insertion order", () => {
  const probe = "require('./tests/helpers/paid-identity.ts').identityProbe().then(value => process.stdout.write(JSON.stringify(value)))";
  const results = [];
  for (const locale of ["en_US.UTF-8", "tr_TR.UTF-8"]) for (const reverse of [false, true]) {
    const result = JSON.parse(execFileSync(process.execPath, ["--import", "tsx", "--eval", probe], {
      env: { ...process.env, ...identityEnvironment(reverse), LANG: locale, LC_ALL: locale, DOTENV_CONFIG_PATH: "/dev/null" }, encoding: "utf8", timeout: 30000,
    }));
    assert.equal(result.scheme, "json-utf16-v1");
    for (const snapshot of result.snapshots) {
      assert.equal(snapshot.hash, snapshot.reorderedHash);
      const baseline = golden.records.find(row => row.profile === snapshot.profile)!;
      assert.equal(snapshot.legacyHash, baseline.hash, "read old immutable hashes, do not re-sign them");
      assert.equal(snapshot.legacyHash, snapshot.originalHash, "explicit legacy compatibility matches the original parser in both locales");
      assert.notEqual(snapshot.hash, snapshot.legacyHash);
      assert.equal(snapshot.version, snapshot.profile === "paid-core-v1" ? "paid-snapshot/3" : "paid-snapshot/4");
    }
    results.push(result);
  }
  for (const result of results) assert.deepEqual(result, results[0], "config/contentVersion/offer/settings/snapshot/report/sample/corpus identities are portable");
});
