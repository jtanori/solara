import type { Role } from "@/lib/types";

/**
 * The role matrix — pure predicates, no database import.
 *
 * These lived in `auth.ts`, which imports `@/db` and therefore throws at module
 * load when DATABASE_URL is unset. A boolean function over a string should not
 * need a Postgres connection to be called or tested; the practical consequence
 * was that any test of an authorization rule that imported them failed before
 * running. `auth.ts` re-exports them, so every existing import still works.
 */

export const ROLES: readonly Role[] = ["owner", "admin", "editor", "user"];

export function isRole(value: unknown): value is Role {
  return typeof value === "string" && (ROLES as readonly string[]).includes(value);
}

export function canManageUsers(role: Role): boolean {
  return role === "owner" || role === "admin";
}

export function canEditKnowledge(role: Role): boolean {
  return role === "owner" || role === "editor";
}
