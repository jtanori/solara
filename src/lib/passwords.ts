// Server-only: keep hashing on the server. Do not import this module from a Client Component.
// Next.js `import "server-only"` would enforce this at build, but it breaks plain `tsx --test`
// imports, so we document the invariant here and rely on the build-time check.
// See P3 in PR #17 review.
import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const scryptAsync = promisify(scrypt) as (
  password: string,
  salt: string,
  keylen: number,
) => Promise<Buffer>;

const MAX_CONCURRENT_SCRYPT = 4;
let activeScrypt = 0;
const scryptQueue: Array<() => void> = [];

async function acquireScryptSlot(): Promise<void> {
  if (activeScrypt < MAX_CONCURRENT_SCRYPT) {
    activeScrypt++;
    return;
  }
  await new Promise<void>((resolve) => { scryptQueue.push(resolve); });
  activeScrypt++;
}

function releaseScryptSlot(): void {
  activeScrypt--;
  scryptQueue.shift()?.();
}

async function runScrypt(password: string, salt: string): Promise<Buffer> {
  await acquireScryptSlot();
  try {
    return await scryptAsync(password, salt, 64);
  } finally {
    releaseScryptSlot();
  }
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16).toString("hex");
  try {
    const hash = await runScrypt(password, salt);
    return `${salt}:${hash.toString("hex")}`;
  } catch {
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
    actual = await runScrypt(password, salt);
  } catch {
    return false;
  }
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
