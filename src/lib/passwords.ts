// Server-only: keep hashing on the server. Do not import this module from a Client Component.
// Next.js `import "server-only"` would enforce this at build, but it breaks plain `tsx --test`
// imports, so we document the invariant here and rely on the build-time check.
// See P3 in PR #17 review.
import { randomBytes, timingSafeEqual } from "node:crypto";
import {
  DEFAULT_SCRYPT_PARAMS,
  ScryptBusyError,
  SCRYPT_PARAM_LIMITS,
  scryptPool,
  type ScryptParams,
} from "@/lib/scrypt-pool";

/**
 * Stored password hash formats.
 *
 * Current:  `scrypt$N$r$p$saltHex$hashHex`
 * Legacy:   `saltHex:hashHex`  (implicit Node-default scrypt parameters)
 *
 * The legacy form is still *accepted* forever — every account created before
 * this change stores it, and refusing it would lock those users out with no
 * recovery path. It is upgraded opportunistically: `needsRehash()` reports
 * which stored hashes are behind the current format or cost, and a successful
 * login re-hashes with the current parameters (see `auth-service.ts`).
 *
 * Why the parameters are in the hash (S8): `scryptPool.run` used to take no
 * cost arguments, so the cost lived only inside Node's defaults. Raising it
 * later would have left old hashes verifiable *only* by guessing which cost
 * they used. Recording N/r/p per hash makes the upgrade a matter of comparison
 * rather than archaeology.
 *
 * This module is the only place that parses or builds a password hash. Nothing
 * else should split on `$` or `:` — including the login rehash path, which asks
 * `needsRehash()` instead of inspecting the string itself.
 */

const CURRENT_ALGORITHM = "scrypt";
const MAX_HASH_LENGTH = 512;

/** A parsed stored hash, in whichever form it was found. */
type ParsedHash =
  | { format: "v2"; params: ScryptParams; salt: string; hash: string }
  | { format: "legacy"; params: ScryptParams; salt: string; hash: string };

function isSafePositiveInteger(value: number, max: number): boolean {
  return Number.isSafeInteger(value) && value > 0 && value <= max;
}

/**
 * Parse a stored hash. Returns `null` for anything unrecognised, so a corrupt
 * or truncated row is a failed comparison rather than a throw — a login must
 * never 500 because one user's hash is malformed.
 */
function parseStoredHash(stored: string): ParsedHash | null {
  if (!stored || stored.length > MAX_HASH_LENGTH) return null;

  if (stored.startsWith(`${CURRENT_ALGORITHM}$`)) {
    const parts = stored.split("$");
    // scrypt $ N $ r $ p $ salt $ hash
    if (parts.length !== 6) return null;
    const [, rawN, rawR, rawP, salt, hash] = parts;
    if (!/^\d{1,7}$/.test(rawN) || !/^\d{1,3}$/.test(rawR) || !/^\d{1,3}$/.test(rawP)) return null;
    const N = Number(rawN);
    const r = Number(rawR);
    const p = Number(rawP);
    if (!isSafePositiveInteger(N, SCRYPT_PARAM_LIMITS.maxN)) return null;
    if (!isSafePositiveInteger(r, SCRYPT_PARAM_LIMITS.maxR)) return null;
    if (!isSafePositiveInteger(p, SCRYPT_PARAM_LIMITS.maxP)) return null;
    // scrypt requires N to be a power of two greater than 1.
    if (N <= 1 || (N & (N - 1)) !== 0) return null;
    if (!/^[0-9a-f]{32}$/.test(salt)) return null;
    if (!/^[0-9a-f]{128}$/.test(hash)) return null;
    return { format: "v2", params: { N, r, p }, salt, hash };
  }

  // Legacy `salt:hash`. Two parts exactly — anything else is not this format.
  const parts = stored.split(":");
  if (parts.length !== 2) return null;
  const [salt, hash] = parts;
  if (!/^[0-9a-f]{32}$/.test(salt)) return null;
  if (!/^[0-9a-f]{128}$/.test(hash)) return null;
  return { format: "legacy", params: DEFAULT_SCRYPT_PARAMS, salt, hash };
}

function formatHash(params: ScryptParams, salt: string, hash: Buffer): string {
  return `${CURRENT_ALGORITHM}$${params.N}$${params.r}$${params.p}$${salt}$${hash.toString("hex")}`;
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16).toString("hex");
  try {
    const hash = await scryptPool.run(password, salt, DEFAULT_SCRYPT_PARAMS);
    return formatHash(DEFAULT_SCRYPT_PARAMS, salt, hash);
  } catch (error) {
    if (error instanceof ScryptBusyError) throw error;
    throw new Error("Password hashing failed.");
  }
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parsed = parseStoredHash(stored);
  if (!parsed) return false;
  // Explicit hex/length checks so failure is intentional, not an accident of Buffer truncation
  // (the regexes in `parseStoredHash` are those checks).
  const expected = Buffer.from(parsed.hash, "hex");
  let actual: Buffer;
  try {
    actual = await scryptPool.run(password, parsed.salt, parsed.params);
  } catch (error) {
    if (error instanceof ScryptBusyError) throw error;
    return false;
  }
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

/**
 * The cost a *new* hash should use. Separate from `DEFAULT_SCRYPT_PARAMS` so a
 * future cost bump is one constant, and so `needsRehash` has something to
 * compare against that is not "whatever we happen to hash with today".
 */
export const CURRENT_SCRYPT_PARAMS: ScryptParams = DEFAULT_SCRYPT_PARAMS;

/**
 * True when a stored hash should be replaced after a successful verification:
 * it is in the legacy format, or its recorded cost is below the current one.
 *
 * Callers must only pass a hash that has *just* verified. Rehashing an
 * unverified hash would let anyone who can read a hash row upgrade it, and
 * more importantly would mean a wrong password could still mutate the account.
 */
export function needsRehash(stored: string): boolean {
  const parsed = parseStoredHash(stored);
  if (!parsed) return false; // Unparseable is not "needs rehash" — there is nothing to re-verify against.
  if (parsed.format === "legacy") return true;
  const current = CURRENT_SCRYPT_PARAMS;
  return (
    parsed.params.N < current.N
    || parsed.params.r < current.r
    || parsed.params.p < current.p
  );
}
