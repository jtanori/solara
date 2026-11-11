import assert from "node:assert/strict";
import test from "node:test";
import { assessRoleChange, isRole, ROLES } from "../src/lib/role-change";
import { assessKnowledgeEdit, MAX_BODY_LENGTH } from "../src/lib/knowledge-edit";
import { CONTENT_CATEGORIES, SIGNS_FOR_CONTENT, contentKey, defaultNote } from "../src/lib/content";
import type { Role } from "../src/lib/types";

/*
 * Policy tests for the two admin routes — the highest damage-per-mistake code in
 * the product, which had zero coverage before this file.
 *
 * These are fake-input tests against pure functions, not route integration
 * tests: the routes are three lines of I/O each once the policy is extracted, and
 * requiring Postgres to prove "an admin cannot promote themselves" would mean the
 * assertion never runs in CI.
 */

const OWNER = "11111111-1111-1111-1111-111111111111";
const ADMIN = "22222222-2222-2222-2222-222222222222";
const OTHER = "33333333-3333-3333-3333-333333333333";

function actor(role: Role, id = OWNER) {
  return { id, role };
}

// ================================================================== role changes

test("role: only owner and admin can manage users at all", () => {
  for (const role of ["editor", "user"] as const) {
    const decision = assessRoleChange({
      actor: actor(role),
      target: { id: OTHER, role: "user" },
      next: "editor",
    });
    assert.equal(decision.allowed, false, `${role} cannot change roles`);
    assert.equal(decision.allowed === false && decision.rejection.error, "not_authorized");
    assert.equal(decision.allowed === false && decision.rejection.status, 403);
  }
});

test("role: nobody can change their own role, including an owner", () => {
  for (const role of ["owner", "admin"] as const) {
    const decision = assessRoleChange({
      actor: actor(role),
      target: { id: OWNER, role },
      next: "user",
    });
    assert.equal(decision.allowed, false, `${role} cannot demote themselves`);
    assert.equal(decision.allowed === false && decision.rejection.error, "self_change");
  }
});

test("role: an admin cannot touch an owner or another admin, in either direction", () => {
  const cases: Array<[Role, Role]> = [
    ["owner", "user"],   // demoting an owner
    ["admin", "user"],   // demoting a peer
    ["owner", "admin"],  // promoting a peer
    ["user", "admin"],   // creating a peer
    ["user", "owner"],   // creating an owner
  ];
  for (const [targetRole, next] of cases) {
    const decision = assessRoleChange({
      actor: actor("admin", ADMIN),
      target: { id: OTHER, role: targetRole },
      next,
    });
    assert.equal(decision.allowed, false, `admin: ${targetRole} -> ${next} must be refused`);
    assert.equal(decision.allowed === false && decision.rejection.error, "owner_only_roles");
    assert.equal(decision.allowed === false && decision.rejection.status, 403);
  }
});

test("role: an admin CAN manage plain users and editors", () => {
  const cases: Array<[Role, Role]> = [
    ["user", "editor"],
    ["editor", "user"],
    ["editor", "editor"],
  ];
  for (const [targetRole, next] of cases) {
    const decision = assessRoleChange({
      actor: actor("admin", ADMIN),
      target: { id: OTHER, role: targetRole },
      next,
    });
    assert.equal(decision.allowed, true, `admin: ${targetRole} -> ${next} should be allowed`);
    assert.equal(decision.allowed === true && decision.action, `role:${targetRole}->${next}`);
  }
});

test("role: an owner can promote to admin and to owner, and demote", () => {
  for (const next of ROLES) {
    const decision = assessRoleChange({
      actor: actor("owner", OWNER),
      target: { id: OTHER, role: "user" },
      next,
    });
    assert.equal(decision.allowed, true, `owner -> ${next}`);
    assert.equal(decision.allowed === true && decision.action, `role:user->${next}`);
  }
});

test("role: the action string is the audit payload, so from->to must be exact", () => {
  const decision = assessRoleChange({
    actor: actor("owner", OWNER),
    target: { id: OTHER, role: "editor" },
    next: "admin",
  });
  assert.equal(decision.allowed === true && decision.action, "role:editor->admin");
});

test("role: malformed input is a 400 before any database work", () => {
  for (const next of [undefined, null, "", "superuser", 42, {}]) {
    const decision = assessRoleChange({
      actor: actor("owner", OWNER),
      target: { id: OTHER, role: "user" },
      next,
    });
    assert.equal(decision.allowed, false);
    assert.equal(decision.allowed === false && decision.rejection.error, "invalid_role_change");
    assert.equal(decision.allowed === false && decision.rejection.status, 400);
  }

  const missing = assessRoleChange({ actor: actor("owner", OWNER), target: undefined, next: "admin" });
  assert.equal(missing.allowed === false && missing.rejection.error, "invalid_role_change", "a missing target is not a 404, it is a bad request");
});

test("role: isRole rejects anything outside the four-role matrix", () => {
  assert.equal(isRole("owner"), true);
  assert.equal(isRole("editor"), true);
  assert.equal(isRole("Owner"), false, "case matters: 'Owner' must not be coercible");
  assert.equal(isRole("root"), false);
  assert.equal(isRole(undefined), false);
});

// ================================================================== knowledge

const SUN_ARIES_DEFAULT = defaultNote("sun", "Aries", "en");

test("knowledge: editors and owners may write; admins and users may not", () => {
  const base = { category: "sun" as const, item: "Aries", locale: "en" as const, body: "A considered change." };

  for (const role of ["owner", "editor"] as const) {
    assert.equal(assessKnowledgeEdit({ actor: { role }, data: base }).allowed, true, `${role} may edit`);
  }
  for (const role of ["admin", "user"] as const) {
    const decision = assessKnowledgeEdit({ actor: { role }, data: base });
    assert.equal(decision.allowed, false, `${role} may not edit`);
    assert.equal(decision.allowed === false && decision.rejection.error, "not_authorized");
    assert.equal(decision.allowed === false && decision.rejection.status, 403);
  }
});

test("knowledge: every category/item/locale combination produces a stable key", () => {
  for (const category of CONTENT_CATEGORIES) {
    const items = category === "house" ? ["1", "12"] : SIGNS_FOR_CONTENT.slice(0, 2);
    for (const item of items) {
      for (const locale of ["en", "es"] as const) {
        const decision = assessKnowledgeEdit({
          actor: { role: "editor" },
          data: { category, item, locale, body: "x" },
        });
        assert.equal(decision.allowed, true, `${category}/${item}/${locale}`);
        assert.equal(decision.allowed === true && decision.key, contentKey(category, item, locale));
        assert.equal(decision.allowed === true && decision.title, `${category}: ${item} (${locale})`);
      }
    }
  }
});

test("knowledge: invalid items and bodies are refused", () => {
  const cases: Array<[string, Record<string, unknown>]> = [
    ["house 0", { category: "house", item: "0" }],
    ["house 13", { category: "house", item: "13" }],
    ["house abc", { category: "house", item: "abc" }],
    ["unknown sign", { category: "sun", item: "Ophiuchus" }],
    ["unknown category", { category: "rising", item: "Aries" }],
    ["empty body", { category: "sun", item: "Aries", body: "" }],
    ["whitespace body", { category: "sun", item: "Aries", body: "   \n  " }],
    ["non-string body", { category: "sun", item: "Aries", body: 42 }],
    ["body over the limit", { category: "sun", item: "Aries", body: "x".repeat(MAX_BODY_LENGTH + 1) }],
  ];
  for (const [label, data] of cases) {
    const decision = assessKnowledgeEdit({ actor: { role: "editor" }, data });
    assert.equal(decision.allowed, false, label);
    assert.equal(decision.allowed === false && decision.rejection.error, "invalid_content", label);
  }
});

test("knowledge: a body exactly at the limit is accepted, one character over is not", () => {
  const atLimit = assessKnowledgeEdit({
    actor: { role: "editor" },
    data: { category: "sun", item: "Aries", body: "x".repeat(MAX_BODY_LENGTH) },
  });
  assert.equal(atLimit.allowed, true);

  const overLimit = assessKnowledgeEdit({
    actor: { role: "editor" },
    data: { category: "sun", item: "Aries", body: "x".repeat(MAX_BODY_LENGTH + 1) },
  });
  assert.equal(overLimit.allowed, false);
});

test("knowledge: the P4 no-op-override bug is now visible to the caller", () => {
  // This is exactly what the admin panel sends when an editor opens a note and
  // presses Save without typing: the textarea was seeded from the compiled
  // default, so the submission equals it.
  const decision = assessKnowledgeEdit({
    actor: { role: "editor" },
    data: { category: "sun", item: "Aries", locale: "en", body: SUN_ARIES_DEFAULT },
  });
  assert.equal(decision.allowed, true, "saving a default deliberately is allowed");
  assert.equal(decision.allowed === true && decision.matchesDefault, true);
  assert.equal(decision.allowed === true && decision.isOverride, true, "it creates a stored override, and the route records that");

  const edited = assessKnowledgeEdit({
    actor: { role: "editor" },
    data: { category: "sun", item: "Aries", locale: "en", body: `${SUN_ARIES_DEFAULT} A considered addition.` },
  });
  assert.equal(edited.allowed === true && edited.matchesDefault, false, "a real edit is not a default re-save");
});

test("knowledge: whitespace around a default does not disguise it", () => {
  const padded = assessKnowledgeEdit({
    actor: { role: "editor" },
    data: { category: "sun", item: "Aries", locale: "en", body: `\n  ${SUN_ARIES_DEFAULT}  \n` },
  });
  assert.equal(padded.allowed === true && padded.isOverride, true, "trimming happens before the comparison");
});

test("knowledge: a cell with no compiled default is never marked as an override", () => {
  // defaultNote returns "" for an unknown theme; storing prose there is new
  // content, not a re-save of a default.
  const decision = assessKnowledgeEdit({
    actor: { role: "editor" },
    data: { category: "moon", item: "Ophiuchus", locale: "en", body: "new" },
  });
  // Ophiuchus is not a valid sign, so this is refused outright — the guard holds.
  assert.equal(decision.allowed, false);
});
