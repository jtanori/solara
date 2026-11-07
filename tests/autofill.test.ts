import assert from "node:assert/strict";
import test from "node:test";
import { personalAutocomplete, shouldLimitProfileAutofill } from "../src/lib/autofill";

test("requests reduced profile autofill in Brave without disabling password hints", async () => {
  assert.equal(await shouldLimitProfileAutofill({ brave: { isBrave: async () => true } }), true);
  assert.equal(await shouldLimitProfileAutofill({ brave: { isBrave: async () => false } }), false);
  assert.equal(await shouldLimitProfileAutofill({}), false);
  assert.equal(await shouldLimitProfileAutofill({ brave: { isBrave: async () => { throw new Error("unavailable"); } } }), true);
  assert.equal(await shouldLimitProfileAutofill({ brave: {} }), true);
  for (const token of ["name", "given-name", "email", "bday"] as const) {
    assert.equal(personalAutocomplete(token, true), "off");
    assert.equal(personalAutocomplete(token, false), token);
  }
});
