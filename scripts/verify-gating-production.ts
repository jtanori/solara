// Production-mode gating verifier — see #15
// Exercises the built Next.js server (NODE_ENV=production) against a disposable DB.
// Checks unauthenticated 404s, signed-in role scoping, ignored ?role=, payload leakage, and internal-doc links.
// Usage: after `npm run build` and `npx next start` on port 3000, run with:
//   DATABASE_URL=... npx tsx scripts/verify-gating-production.ts
import "dotenv/config";
import { createHash, randomBytes } from "node:crypto";

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL is required");
  process.exit(1);
}

const BASE = process.env.APP_URL ?? "http://localhost:3000";

function hashToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

async function fetchWithSession(path: string, token?: string) {
  const headers: Record<string, string> = {};
  if (token) headers.Cookie = `solara_session=${token}`;
  const res = await fetch(`${BASE}${path}`, { headers, redirect: "manual" });
  const body = await res.text();
  return { status: res.status, body };
}

function assert(condition: boolean, msg: string) {
  if (!condition) {
    console.error(`FAIL ${msg}`);
    process.exit(1);
  }
  console.log(`PASS ${msg}`);
}

async function main() {
  const { db, pool } = await import("../src/db");
  const { sessions, subscriptions, users } = await import("../src/db/schema");
  const { eq, inArray } = await import("drizzle-orm");

  const OTHER_ROLE_MARKERS: Record<string, string[]> = {
    free: ["Oversee the product", "Shape the words", "Before you sign up", "Manage access", "Go a little deeper"],
    owner: ["Your personal space", "Before you sign up", "Go a little deeper", "Shape the words", "Manage access"],
  };

  async function createUserWithSession(email: string, role: "user" | "editor" | "admin" | "owner", plan: "free" | "paid" = "free") {
    const id = randomBytes(8).toString("hex");
    const emailFull = `${id}-${email}`;
    const passwordHash = "not-a-login-" + randomBytes(4).toString("hex");
    const [user] = await db.insert(users).values({ email: emailFull, name: `Verify ${role}`, role, passwordHash }).returning({ id: users.id });
    const subIds: string[] = [];
    if (plan === "paid") {
      const subId = `sub_verify_${id}`;
      await db.insert(subscriptions).values({
        stripeSubscriptionId: subId,
        userId: user.id,
        stripeCustomerId: `cus_verify_${id}`,
        stripePriceId: "price_mxn_premium_local",
        status: "active",
        currency: "mxn",
        grantsAccess: true,
        currentPeriodEnd: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      });
      subIds.push(subId);
    }
    const token = randomBytes(32).toString("base64url");
    const tokenHash = hashToken(token);
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000);
    await db.insert(sessions).values({ tokenHash, userId: user.id, expiresAt });
    return { userId: user.id, email: emailFull, token, tokenHash, subscriptionIds: subIds };
  }

  async function cleanupUser(userId: string, subscriptionIds: string[], tokenHash: string) {
    if (subscriptionIds.length) await db.delete(subscriptions).where(inArray(subscriptions.stripeSubscriptionId, subscriptionIds));
    await db.delete(sessions).where(eq(sessions.tokenHash, tokenHash));
    await db.delete(users).where(eq(users.id, userId));
  }

  console.log(`Verifying production gating against ${BASE} with DATABASE_URL host ${new URL(process.env.DATABASE_URL!).hostname}`);

  // 1. Unauthenticated 404s for all internal docs
  for (const p of ["/blueprint", "/setup", "/usage-guide"]) {
    const { status, body } = await fetchWithSession(p);
    assert(status === 404, `unauthenticated GET ${p} → 404 (got ${status})`);
    assert(!body.includes("EL PROYECTO DE SOLARA"), `no blueprint leak in ${p} 404 body`);
  }

  // 2. No internal-doc links in public HTML (homepage, pricing, sample)
  for (const p of ["/", "/pricing", "/sample"]) {
    const { body } = await fetchWithSession(p);
    assert(!body.includes('href="/blueprint'), `no /blueprint link in non-dev HTML ${p}`);
    assert(!body.includes('href="/setup'), `no /setup link in non-dev HTML ${p}`);
    assert(!body.includes('href="/usage-guide'), `no /usage-guide link in non-dev HTML ${p}`);
  }

  // 3. Signed-in role scoping — customer vs staff
  const freeCustomer = await createUserWithSession("free@verify.local", "user", "free");
  const premiumCustomer = await createUserWithSession("premium@verify.local", "user", "paid");
  const staffEditor = await createUserWithSession("editor@verify.local", "editor", "free");
  const staffOwner = await createUserWithSession("owner@verify.local", "owner", "paid");

  try {
    // Free customer should see only free guide
    {
      const { status, body } = await fetchWithSession("/usage-guide", freeCustomer.token);
      assert(status === 200, `free customer GET /usage-guide → 200 (got ${status})`);
      assert(body.includes("Your personal space") || body.includes("Your year, at your pace"), "free guide rendered");
      for (const marker of OTHER_ROLE_MARKERS.free) assert(!body.includes(marker), `free payload must not contain other role marker "${marker}"`);
      assert(!body.includes('href="/setup"') && !body.includes('href="/blueprint"'), "free guide hides internal /setup and /blueprint section links");
      // ?role= ignored
      const { body: body2 } = await fetchWithSession("/usage-guide?role=owner", freeCustomer.token);
      assert(body2.includes("Your personal space"), "?role= ignored for free customer (still free)");
      assert(!body2.includes("Oversee the product"), "?role=owner must not leak owner content to free");
    }

    // Owner (staff) should see only owner guide
    {
      const { status, body } = await fetchWithSession("/usage-guide", staffOwner.token);
      assert(status === 200, `owner GET /usage-guide → 200 (got ${status})`);
      assert(body.includes("Oversee the product") || body.includes("Cuida el producto"), "owner guide rendered");
      for (const marker of OTHER_ROLE_MARKERS.owner) assert(!body.includes(marker), `owner payload must not contain other role marker "${marker}"`);
      const { body: body2 } = await fetchWithSession("/usage-guide?role=visitor", staffOwner.token);
      assert(body2.includes("Oversee the product") || body2.includes("Cuida el producto"), "?role=visitor ignored for owner");
      const { body: editorBody } = await fetchWithSession("/usage-guide", staffEditor.token);
      assert(editorBody.includes("Shape the words"), "editor guide rendered");
      assert(!editorBody.includes("Oversee the product"), "editor must not contain owner content");
    }

    // Premium customer role is derived from plan, not just role=user
    {
      const { body } = await fetchWithSession("/usage-guide", premiumCustomer.token);
      assert(body.includes("Go a little deeper") || body.includes("More room to reflect"), "premium guide rendered for paid user");
      assert(!body.includes("Your personal space"), "premium payload must not contain free guide marker");
    }

    // Direct check: response must not be full 6-guide array (simple heuristic: not all 6 captions present)
    {
      const { body } = await fetchWithSession("/usage-guide", freeCustomer.token);
      const captionsPresent = ["Before you sign up", "Your personal space", "Go a little deeper", "Shape the words", "Manage access", "Oversee the product"].filter((c) => body.includes(c)).length;
      assert(captionsPresent === 1, `non-dev usage-guide should contain exactly 1 audience caption (found ${captionsPresent})`);
    }
  } finally {
    await cleanupUser(freeCustomer.userId, freeCustomer.subscriptionIds, freeCustomer.tokenHash);
    await cleanupUser(premiumCustomer.userId, premiumCustomer.subscriptionIds, premiumCustomer.tokenHash);
    await cleanupUser(staffEditor.userId, staffEditor.subscriptionIds, staffEditor.tokenHash);
    await cleanupUser(staffOwner.userId, staffOwner.subscriptionIds, staffOwner.tokenHash);
    await pool.end();
  }

  console.log("All production gating checks passed.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
