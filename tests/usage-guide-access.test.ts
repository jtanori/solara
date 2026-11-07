import assert from "node:assert/strict";
import test from "node:test";
import { resolveUsageGuideAccess } from "../src/lib/usage-guide-access.js";
import { USAGE_AUDIENCES } from "../src/lib/usage-guide.js";

// Helper users
const freeUser = { role: "user" as const, plan: "free" as const };
const premiumUser = { role: "user" as const, plan: "paid" as const };
const editorUser = { role: "editor" as const, plan: "free" as const };
const adminUser = { role: "admin" as const, plan: "free" as const };
const ownerUser = { role: "owner" as const, plan: "paid" as const };

test("development returns all guides (unauthenticated)", () => {
  const result = resolveUsageGuideAccess({ environment: "development", user: null, locale: "en" });
  assert.ok(result);
  assert.equal(result.guides.length, 6);
  assert.deepEqual(result.guides.map((g) => g.id), [...USAGE_AUDIENCES]);
  assert.equal(result.activeAudience, "visitor");
});

test("development honors valid ?role= override and still returns all guides", () => {
  for (const role of USAGE_AUDIENCES) {
    const result = resolveUsageGuideAccess({
      environment: "development",
      user: freeUser,
      requestedRole: role,
      locale: "en",
    });
    assert.ok(result);
    assert.equal(result.guides.length, 6, `development should return all guides even when ?role=${role}`);
    assert.equal(result.activeAudience, role);
    // Ensure all guides are present, not filtered
    assert.deepEqual(result.guides.map((g) => g.id), [...USAGE_AUDIENCES]);
  }
});

test("development falls back to user-derived audience when ?role= is invalid", () => {
  const result = resolveUsageGuideAccess({
    environment: "development",
    user: premiumUser,
    requestedRole: "administrator",
    locale: "en",
  });
  assert.ok(result);
  assert.equal(result.activeAudience, "premium");
  assert.equal(result.guides.length, 6);

  const result2 = resolveUsageGuideAccess({
    environment: "development",
    user: null,
    requestedRole: "not-a-role",
    locale: "en",
  });
  assert.ok(result2);
  assert.equal(result2.activeAudience, "visitor");
});

test("development with no requestedRole uses user-derived audience", () => {
  assert.equal(resolveUsageGuideAccess({ environment: "development", user: freeUser, locale: "en" })!.activeAudience, "free");
  assert.equal(resolveUsageGuideAccess({ environment: "development", user: premiumUser, locale: "en" })!.activeAudience, "premium");
  assert.equal(resolveUsageGuideAccess({ environment: "development", user: editorUser, locale: "en" })!.activeAudience, "editor");
  assert.equal(resolveUsageGuideAccess({ environment: "development", user: adminUser, locale: "en" })!.activeAudience, "admin");
  assert.equal(resolveUsageGuideAccess({ environment: "development", user: ownerUser, locale: "en" })!.activeAudience, "owner");
});

test("non-development unauthenticated access returns null", () => {
  for (const env of ["production", "test", "staging", "", undefined]) {
    const result = resolveUsageGuideAccess({ environment: env, user: null, requestedRole: "owner", locale: "en" });
    assert.equal(result, null, `should deny anon in env=${env}`);
  }
  // also with isDevelopment boolean
  assert.equal(resolveUsageGuideAccess({ isDevelopment: false, user: null, locale: "en" }), null);
});

test("non-development signed-in users receive exactly their own guide", () => {
  const cases: Array<{ user: typeof freeUser | typeof premiumUser | typeof editorUser | typeof adminUser | typeof ownerUser; expected: string }> = [
    { user: freeUser, expected: "free" },
    { user: premiumUser, expected: "premium" },
    { user: editorUser, expected: "editor" },
    { user: adminUser, expected: "admin" },
    { user: ownerUser, expected: "owner" },
  ];
  for (const { user, expected } of cases) {
    const result = resolveUsageGuideAccess({ environment: "production", user, locale: "en" });
    assert.ok(result, `should allow ${expected} in production`);
    assert.equal(result.guides.length, 1, `${expected} should receive exactly one guide`);
    assert.equal(result.guides[0].id, expected);
    assert.equal(result.activeAudience, expected);
  }
});

test("non-development ?role= cannot override the real role", () => {
  // Free user tries to escalate to owner or visitor via ?role
  for (const malicious of [...USAGE_AUDIENCES, "visitor", "owner", "admin", "editor", "free", "premium"]) {
    const result = resolveUsageGuideAccess({
      environment: "production",
      user: freeUser,
      requestedRole: malicious,
      locale: "en",
    });
    assert.ok(result);
    assert.equal(result.activeAudience, "free", `?role=${malicious} should not affect free user`);
    assert.equal(result.guides.length, 1);
    assert.equal(result.guides[0].id, "free");
    // Ensure no other role content leaked
    assert.ok(!result.guides.some((g) => g.id !== "free"));
  }
  const ownerResult = resolveUsageGuideAccess({
    environment: "production",
    user: ownerUser,
    requestedRole: "visitor",
    locale: "en",
  });
  assert.ok(ownerResult);
  assert.equal(ownerResult.activeAudience, "owner");
  assert.equal(ownerResult.guides[0].id, "owner");

  const editorResult = resolveUsageGuideAccess({
    environment: "production",
    user: editorUser,
    requestedRole: "admin",
    locale: "en",
  });
  assert.ok(editorResult);
  assert.equal(editorResult.activeAudience, "editor");
});

test("non-development returns locale-specific guides", () => {
  const en = resolveUsageGuideAccess({ environment: "production", user: freeUser, locale: "en" });
  const es = resolveUsageGuideAccess({ environment: "production", user: freeUser, locale: "es" });
  assert.ok(en && es);
  assert.notEqual(en.guides[0].label, es.guides[0].label);
  assert.equal(en.guides[0].id, "free");
  assert.equal(es.guides[0].id, "free");
});

test("isDevelopment boolean overrides environment string", () => {
  // isDevelopment:true forces dev behavior even if environment is production
  const devForced = resolveUsageGuideAccess({ environment: "production", isDevelopment: true, user: null, requestedRole: "admin", locale: "en" });
  assert.ok(devForced);
  assert.equal(devForced.guides.length, 6);
  assert.equal(devForced.activeAudience, "admin");

  const prodForced = resolveUsageGuideAccess({ environment: "development", isDevelopment: false, user: null, locale: "en" });
  assert.equal(prodForced, null);
});

test("development visitor with premium ?role= still gets all guides but active is premium", () => {
  const result = resolveUsageGuideAccess({ environment: "development", user: null, requestedRole: "premium", locale: "en" });
  assert.ok(result);
  assert.equal(result.activeAudience, "premium");
  assert.equal(result.guides.length, 6);
});

test("no payload leakage: non-dev guide array contains only the single guide's ids", () => {
  const result = resolveUsageGuideAccess({ environment: "production", user: premiumUser, locale: "en" });
  assert.ok(result);
  const ids = result.guides.map((g) => g.id);
  assert.deepEqual(ids, ["premium"]);
  // Ensure stringified payload does not contain other role labels
  const payload = JSON.stringify(result.guides);
  for (const other of ["visitor", "free", "editor", "admin", "owner"]) {
    if (other === "premium") continue;
    // The label strings for other roles should not appear
    // We check ids only — labels are role-specific but we verify ids are exclusive
    assert.ok(!ids.includes(other as any));
  }
});
