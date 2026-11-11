import type { Role } from "@/lib/types";

/**
 * Account deletion policy (auth amendment §S1, §S5).
 *
 * Deletion is the most destructive action a session can take: it cascades to
 * readings, reading documents, sessions and subscriptions. Every other
 * destructive path already demands proof beyond the session — password reset
 * needs the emailed token, account claim needs the claim token, role changes
 * need the admin role. This module makes the gate explicit and testable without
 * a database, in the same shape as `usage-guide-access-core.ts`: a pure core the
 * route calls, with the side effects (password verification, Stripe, the delete
 * itself) left to the caller.
 */

export type DeletionCode =
  | "email_not_verified"
  | "owner_account"
  | "password_required"
  | "invalid_password"
  | "subscription_ongoing"
  | "billing_unverifiable";

export type DeletionBlocker = {
  /** HTTP status the route returns. */
  status: 400 | 403 | 409 | 503;
  code: DeletionCode;
  message: { en: string; es: string };
};

export type DeletionGate =
  /** Cheap facts only — enough to reject before any password is hashed. */
  | { kind: "blocked"; blocker: DeletionBlocker }
  | { kind: "continue" };

/**
 * Result of the password step. `null` means "not verified yet", which is what
 * lets the route run the cheap checks first and hash only for a request that
 * could otherwise succeed.
 */
export type PasswordFacts = {
  /** A password was present in the request body. */
  submitted: boolean;
  /** `verifyPassword(...)` result; null before verification is attempted. */
  matches: boolean | null;
};

const emailUnverified: DeletionBlocker = {
  status: 403,
  code: "email_not_verified",
  message: {
    en: "Verify your email before deleting your account.",
    es: "Verifica tu correo antes de eliminar tu cuenta.",
  },
};

const ownerAccount: DeletionBlocker = {
  status: 400,
  code: "owner_account",
  message: {
    en: "Owner accounts must be transferred before deletion.",
    es: "Transfiere la cuenta propietaria antes de eliminarla.",
  },
};

const passwordRequired: DeletionBlocker = {
  status: 400,
  code: "password_required",
  message: {
    en: "Enter your password to delete your account.",
    es: "Escribe tu contraseña para eliminar tu cuenta.",
  },
};

const invalidPassword: DeletionBlocker = {
  status: 400,
  code: "invalid_password",
  message: {
    en: "That password is not correct.",
    es: "Esa contraseña no es correcta.",
  },
};

const subscriptionOngoing: DeletionBlocker = {
  status: 409,
  code: "subscription_ongoing",
  message: {
    en: "Cancel your subscription in the billing portal and wait for it to end before deleting your account.",
    es: "Cancela tu suscripción en el portal de facturación y espera a que termine antes de eliminar tu cuenta.",
  },
};

const billingUnverifiable: DeletionBlocker = {
  status: 503,
  code: "billing_unverifiable",
  message: {
    en: "We could not verify billing. Please try again later.",
    es: "No pudimos verificar tu facturación. Inténtalo más tarde.",
  },
};

/**
 * The gate, evaluated in a deliberate order:
 *
 *   1. unverified email  — cheap, and a claim link is the only way in
 *   2. owner role        — cheap; ownership has no automated transfer (#P7)
 *   3. password present  — cheap; avoids hashing on an obviously bad request
 *   4. password matches  — expensive (scrypt), so it runs fourth
 *   5. billing state     — network/DB, so it runs last
 *
 * Password is checked BEFORE billing on purpose: a stolen session should not be
 * able to use this endpoint to learn whether the account has a live
 * subscription, or to expire its open checkout sessions (which the billing
 * branch does as a side effect). Cheap-and-decisive first is also why a request
 * with no password never touches scrypt.
 */
export function assessDeletionGate(facts: {
  role: Role;
  emailVerified: boolean;
  password: PasswordFacts;
}): DeletionGate {
  if (!facts.emailVerified) return { kind: "blocked", blocker: emailUnverified };
  if (facts.role === "owner") return { kind: "blocked", blocker: ownerAccount };
  if (!facts.password.submitted) return { kind: "blocked", blocker: passwordRequired };
  if (facts.password.matches === false) return { kind: "blocked", blocker: invalidPassword };
  // matches === null: the caller has not verified the password yet.
  return { kind: "continue" };
}

export type BillingState =
  /** No live subscription found in our table or in Stripe. */
  | "clear"
  /** A subscription is active, trialing, past_due, or otherwise still open. */
  | "ongoing"
  /** Stripe was configured for this customer but could not be reached. */
  | "unverifiable";

/** Billing is the last gate: it is the one that costs a network round trip. */
export function assessBillingGate(state: BillingState): DeletionBlocked | { kind: "continue" } {
  if (state === "ongoing") return { kind: "blocked", blocker: subscriptionOngoing };
  if (state === "unverifiable") return { kind: "blocked", blocker: billingUnverifiable };
  return { kind: "continue" };
}

export type DeletionBlocked = { kind: "blocked"; blocker: DeletionBlocker };

/** Localized body for a blocked decision. Keeps the route free of copy. */
export function blockedResponseBody(blocker: DeletionBlocker, locale: "en" | "es") {
  return { error: blocker.message[locale], code: blocker.code };
}

/**
 * The audit row written in the same transaction as the delete.
 *
 * `audit_logs.actor_id` references `users.id` with `on delete set null`, so this
 * row survives the deletion with a null actor while `target` keeps the id —
 * which is exactly what an audit trail needs: the event outlives the account.
 */
export function accountDeletionAudit(userId: string) {
  return { actorId: userId, action: "account:delete" as const, target: userId };
}
