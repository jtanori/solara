// Server-only: keep hashing on the server. Do not import this module from a Client Component.
// Next.js `import "server-only"` would enforce this at build, but it breaks plain `tsx --test`
// imports, so we document the invariant here and rely on the build-time check.
// See P3 in PR #17 review.
import { randomBytes, timingSafeEqual } from "node:crypto";
import { ScryptBusyError, scryptPool } from "@/lib/scrypt-pool";

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16).toString("hex");
  try {
    const hash = await scryptPool.run(password, salt);
    return `${salt}:${hash.toString("hex")}`;
  } catch (error) {
    if (error instanceof ScryptBusyError) throw error;
    throw new Error("Password hashing failed.");
  }
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [salt, hash] = stored.split(":");
  if (!salt || !hash) return false;
  // Explicit hex/length checks so failure is intentional, not an accident of Buffer truncation.
  if (!/^[0-9a-f]{32}$/.test(salt)) return false;
  if (!/^[0-9a-f]{128}$/.test(hash)) return false;
  const expected = Buffer.from(hash, "hex");
  let actual: Buffer;
  try {
    actual = await scryptPool.run(password, salt);
  } catch (error) {
    if (error instanceof ScryptBusyError) throw error;
    return false;
  }
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
