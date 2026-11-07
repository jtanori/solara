// Server-only: keep hashing on the server. Do not import this module from a Client Component.
// Next.js `import "server-only"` would enforce this at build, but it breaks plain `tsx --test`
// imports, so we document the invariant here and rely on the build-time check.
// See P3 in PR #17 review.
import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString("hex");
  return `${salt}:${scryptSync(password, salt, 64).toString("hex")}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [salt, hash] = stored.split(":");
  if (!salt || !hash) return false;
  // Explicit hex/length checks so failure is intentional, not an accident of Buffer truncation.
  if (!/^[0-9a-f]{32}$/.test(salt)) return false;
  if (!/^[0-9a-f]{128}$/.test(hash)) return false;
  const expected = Buffer.from(hash, "hex");
  const actual = scryptSync(password, salt, 64);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
