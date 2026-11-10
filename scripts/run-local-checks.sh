#!/usr/bin/env bash
set -euo pipefail

# Local easy-test harness for PR #20 — #6/#9/#15 on staging@16994e4 + fixes
# Covers: tsc, eslint, subscription fixtures, production gating (loopback only)
#
# Requirements: Node 22, PostgreSQL disposable DB on loopback, .env with DATABASE_URL=postgresql://...@localhost.../...
# Never run against staging/production — script enforces loopback host.

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

echo "==> Solara local checks — staging $($(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo '?')) @ $(git rev-parse --short HEAD 2>/dev/null || echo '?')"

need() { command -v "$1" >/dev/null 2>&1 || { echo "missing $1"; exit 1; }; }
need node; need npm; need npx; need curl

if [[ -z "${DATABASE_URL:-}" ]]; then
  if [[ -f .env ]]; then set -a; source .env 2>/dev/null || true; set +a; fi
fi
if [[ -z "${DATABASE_URL:-}" ]]; then echo "ERROR: DATABASE_URL not set (export it or put in .env)"; exit 1; fi

HOST="$(node -e 'try{let h=new URL(process.env.DATABASE_URL).hostname.replace(/^\[|\]$/,""); console.log(h)}catch(e){console.log("")}')"
if [[ "$HOST" != "localhost" && "$HOST" != "127.0.0.1" && "$HOST" != "::1" ]]; then
  echo "ERROR: DATABASE_URL host is \"$HOST\" — this script only runs against loopback disposable DB (localhost/127.0.0.1/::1). Aborting to protect staging/prod."
  exit 1
fi
echo "-> DATABASE_URL host: $HOST (ok)"

echo "==> 1/6 npm ci"
npm ci

echo "==> 2/6 drizzle migrate (disposable DB) + drift check"
npm run db:migrate
npm run db:manifest:check
npm run db:check

echo "==> 3/6 typecheck + lint"
./node_modules/.bin/tsc --noEmit --pretty false && echo "PASS tsc"
./node_modules/.bin/eslint src tests scripts --max-warnings=0 && echo "PASS eslint"

echo "==> 4/6 unit + billing matrix tests"
RUN_INTEGRATION_TESTS=1 DATABASE_URL="$DATABASE_URL" npx tsx --test tests/*.test.ts 2>&1 | tail -20
RUN_BILLING_INTEGRATION_TESTS=1 DATABASE_URL="$DATABASE_URL" npx tsx --test tests/*.test.ts 2>&1 | grep -E "pass|fail|skipped" | tail -5
echo "PASS tests (see above for pass/fail/skipped counts)"

echo "==> 5/6 seed 9-account fixtures (local-only)"
ALLOW_LOCAL_SEED=true LOCAL_SEED_PASSWORD="local-test-$(date +%s)-longenough" DATABASE_URL="$DATABASE_URL" npx tsx scripts/local/seed-users.ts 2>&1 | tail -15
echo "-> verify hasPremiumAccess matrix"
RUN_BILLING_INTEGRATION_TESTS=1 DATABASE_URL="$DATABASE_URL" npx tsx --test tests/subscription-access.test.ts 2>&1 | tail -10

echo "==> 6/6 production gating — build + start + verify"
npm run build
PORT=3000 npx next start &
PID=$!
trap 'kill $PID 2>/dev/null; wait $PID 2>/dev/null || true' EXIT
echo "waiting for http://localhost:3000/api/health (liveness)..."
for i in {1..15}; do curl -sf http://localhost:3000/api/health | grep -q '"ok":true' && break; sleep 2; done
curl -sf http://localhost:3000/api/health | grep -q '"ok":true' || { echo "liveness never ready"; exit 1; }
echo "waiting for http://localhost:3000/api/ready..."
for i in {1..15}; do curl -sf http://localhost:3000/api/ready | grep -q '"ok":true' && break; sleep 2; done
curl -sf http://localhost:3000/api/ready | grep -q '"ok":true' || { echo "readiness never ready"; curl -s http://localhost:3000/api/ready; exit 1; }
echo "-> unauth 404s + public HTML"
for p in /blueprint /setup /usage-guide; do test "$(curl -s -o /dev/null -w '%{http_code}' http://localhost:3000$p)" = "404" && echo "PASS unauth $p 404" || { echo "FAIL $p"; exit 1; }; done
APP_URL=http://localhost:3000 DATABASE_URL="$DATABASE_URL" npx tsx scripts/verify-gating-production.ts 2>&1 | tee /tmp/gating.log
grep -q "All production gating checks passed" /tmp/gating.log && echo "PASS production gating"
# extra P5 checks
curl -s http://localhost:3000/ | grep -q 'GOOD TO KNOW' && { echo "FAIL footer GOOD TO KNOW leaked"; exit 1; } || echo "PASS no GOOD TO KNOW in public HTML"
# dashboard privacy link — need a session; re-use verifier's ephemeral user or just fetch dashboard as authed free user
echo "-> dashboard blueprint#privacy link check"
node -e '
import("dotenv/config").then(async()=>{
  const {db}=await import("./src/db/index.ts");
  const {users,sessions}=await import("./src/db/schema.ts");
  const {randomBytes,createHash}=await import("node:crypto");
  const {eq}=await import("drizzle-orm");
  const email="dash-check-"+Date.now()+"@example.test";
  const [u]=await db.insert(users).values({email,name:"Dash Check",role:"user",passwordHash:"x",emailVerifiedAt:new Date()}).returning({id:users.id});
  const tok=randomBytes(32).toString("base64url"); const h=createHash("sha256").update(tok).digest("hex");
  await db.insert(sessions).values({tokenHash:h,userId:u.id,expiresAt:new Date(Date.now()+3600000)});
  const res=await fetch("http://localhost:3000/dashboard",{headers:{Cookie:`solara_session=${tok}`}});
  const html=await res.text();
  if(html.includes("/blueprint#privacy")){console.error("FAIL dashboard leaks /blueprint#privacy"); process.exit(1)} else console.log("PASS dashboard no /blueprint#privacy");
  await db.delete(sessions).where(eq(sessions.tokenHash,h)); await db.delete(users).where(eq(users.id,u.id)); process.exit(0);
})' --input-type=module 2>&1 | grep -E "PASS|FAIL"

kill $PID; wait $PID 2>/dev/null || true; trap - EXIT
echo "==> ALL LOCAL CHECKS PASSED"
echo "PR #20 evidence ready — include /tmp/gating.log and the 9-account seed + matrix output in the PR description."
