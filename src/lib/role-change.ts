import type { Role } from "@/lib/types";
import { canManageUsers, isRole, ROLES } from "@/lib/roles";

export { isRole, ROLES };

/**
 * Role-change policy (`api/admin/users`), extracted from the route so the
 * escalation bounds are testable without a database or a request.
 *
 * Two properties matter and both are easy to lose in a refactor:
 *
 *  1. An actor may never change their own role. Otherwise an admin promotes
 *     themselves to owner and the matrix is decorative.
 *  2. An admin may not touch an owner or another admin, and may not *create* one.
 *     The check covers both `target.role` and `next`, because checking only the
 *     target lets an admin promote a plain user to admin — escalation in two
 *     steps instead of one.
 */

export type RoleChangeRejection =
  | { status: 403; error: "not_authorized" }
  | { status: 400; error: "invalid_role_change" }
  | { status: 400; error: "self_change" }
  | { status: 403; error: "owner_only_roles" };

export type RoleChangeDecision =
  /**
   * A no-op change (`editor` -> `editor`) is ALLOWED rather than rejected: the
   * admin panel can re-submit an unchanged select, and rejecting it would surface
   * an error for something the person did not do. It still writes an audit row
   * with an identical from/to, which is honest about what happened.
   */
  | { allowed: true; action: `role:${Role}->${Role}` }
  | { allowed: false; rejection: RoleChangeRejection };

export function assessRoleChange(input: {
  actor: { id: string; role: Role };
  target: { id: string; role: Role } | undefined;
  next: unknown;
}): RoleChangeDecision {
  const { actor, target, next } = input;

  if (!canManageUsers(actor.role)) {
    return { allowed: false, rejection: { status: 403, error: "not_authorized" } };
  }
  if (!target || !isRole(next)) {
    return { allowed: false, rejection: { status: 400, error: "invalid_role_change" } };
  }
  if (target.id === actor.id) {
    return { allowed: false, rejection: { status: 400, error: "self_change" } };
  }
  if (actor.role === "admin" && (
    target.role === "owner" || target.role === "admin" || next === "owner" || next === "admin"
  )) {
    return { allowed: false, rejection: { status: 403, error: "owner_only_roles" } };
  }
  return { allowed: true, action: `role:${target.role}->${next}` };
}
