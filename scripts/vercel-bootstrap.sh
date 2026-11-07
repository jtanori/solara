#!/usr/bin/env bash
# Vercel bootstrap — creates/links project and pushes per-env secrets.
# Disposable: safe to re-run. Never commit .env.staging / .env.production (gitignored).
# Usage:
#   1. npm i -g vercel
#   2. vercel login  # browser
#   3. cp .env.staging.example .env.staging  # fill Neon pooled URL + APP_URL + Stripe test keys
#      cp .env.production.example .env.production
#   4. chmod +x scripts/vercel-bootstrap.sh && ./scripts/vercel-bootstrap.sh
#   5. For direct DB migrations (never in Vercel):
#      export DATABASE_URL="<NEON_DIRECT_URL>" && npx drizzle-kit migrate
set -euo pipefail

PROJECT="${PROJECT:-solara}"
STAGING_URL="${STAGING_URL:-https://staging.solara.vercel.app}"
PROD_URL="${PROD_URL:-https://solara.vercel.app}"

require_cmd() { command -v "$1" >/dev/null 2>&1 || { echo "ERROR: $1 not found. Install with: npm i -g $1"; exit 1; }; }
require_cmd vercel

if [ ! -f ".env.staging" ] && [ ! -f ".env.staging.example" ]; then echo "WARN: .env.staging not found. Copy from .env.staging.example first."; fi
if [ ! -f ".env.production" ] && [ ! -f ".env.production.example" ]; then echo "WARN: .env.production not found. Copy from .env.production.example first."; fi

# Link if not linked
if [ ! -d ".vercel" ]; then
  echo "Linking to Vercel project..."
  vercel link --project "$PROJECT" --yes || vercel link --yes
fi

add_env() {
  local key="$1" val="$2" env="$3" branch="$4"
  if [ -z "$val" ]; then echo "WARN: $key empty — skipping"; return; fi
  echo "Adding $key → $env/$branch"
  # --git-branch scopes to that branch; remove if Vercel plan doesn't support it and use UI scoping instead
  printf "%s" "$val" | vercel env add "$key" "$env" --git-branch "$branch" --yes 2>&1 | tail -1 || \
  printf "%s" "$val" | vercel env add "$key" "$env" --yes 2>&1 | tail -1 || echo "WARN: vercel env add $key failed — set manually in UI"
}

load_env() {
  local file="$1"; local key="$2"
  if [ -f "$file" ]; then grep -E "^${key}=" "$file" | cut -d= -f2- | head -1 || true; else echo ""; fi
}

# Staging → Preview/staging
if [ -f ".env.staging" ]; then
  SRC=".env.staging"
else
  SRC=".env.staging.example"
  echo "Using .env.staging.example as placeholder — replace with real .env.staging before production"
fi
add_env DATABASE_URL "$(load_env "$SRC" DATABASE_URL)" preview staging
add_env APP_URL "$(load_env "$SRC" APP_URL)" preview staging
add_env STRIPE_SECRET_KEY "$(load_env "$SRC" STRIPE_SECRET_KEY)" preview staging
add_env STRIPE_WEBHOOK_SECRET "$(load_env "$SRC" STRIPE_WEBHOOK_SECRET)" preview staging
add_env STRIPE_PRICE_ID_MXN "$(load_env "$SRC" STRIPE_PRICE_ID_MXN)" preview staging
add_env STRIPE_PRICE_ID_USD "$(load_env "$SRC" STRIPE_PRICE_ID_USD)" preview staging
add_env STRIPE_PREMIUM_PRICE_IDS "$(load_env "$SRC" STRIPE_PREMIUM_PRICE_IDS)" preview staging
add_env OPEN_METEO_API_KEY "$(load_env "$SRC" OPEN_METEO_API_KEY)" preview staging
add_env NEXT_PUBLIC_MAP_TILE_URL "$(load_env "$SRC" NEXT_PUBLIC_MAP_TILE_URL)" preview staging
add_env NEXT_PUBLIC_MAP_ATTRIBUTION "$(load_env "$SRC" NEXT_PUBLIC_MAP_ATTRIBUTION)" preview staging

# Production → Production/main (live keys only)
if [ -f ".env.production" ]; then
  SRC=".env.production"
else
  SRC=".env.production.example"
  echo "Using .env.production.example as placeholder"
fi
add_env DATABASE_URL "$(load_env "$SRC" DATABASE_URL)" production main
add_env APP_URL "$(load_env "$SRC" APP_URL)" production main
add_env STRIPE_SECRET_KEY "$(load_env "$SRC" STRIPE_SECRET_KEY)" production main
add_env STRIPE_WEBHOOK_SECRET "$(load_env "$SRC" STRIPE_WEBHOOK_SECRET)" production main
add_env STRIPE_PRICE_ID_MXN "$(load_env "$SRC" STRIPE_PRICE_ID_MXN)" production main
add_env STRIPE_PRICE_ID_USD "$(load_env "$SRC" STRIPE_PRICE_ID_USD)" production main
add_env STRIPE_PREMIUM_PRICE_IDS "$(load_env "$SRC" STRIPE_PREMIUM_PRICE_IDS)" production main
add_env OPEN_METEO_API_KEY "$(load_env "$SRC" OPEN_METEO_API_KEY)" production main
add_env NEXT_PUBLIC_MAP_TILE_URL "$(load_env "$SRC" NEXT_PUBLIC_MAP_TILE_URL)" production main
add_env NEXT_PUBLIC_MAP_ATTRIBUTION "$(load_env "$SRC" NEXT_PUBLIC_MAP_ATTRIBUTION)" production main

echo ""
echo "Envs pushed. Current remote state:"
vercel env ls || echo "Run vercel env ls in UI: https://vercel.com/dashboard → $PROJECT → Settings → Environment Variables"

echo ""
echo "Domains (UI-only): Settings → Domains → add $STAGING_URL → branch staging (Preview), $PROD_URL → Production/main"
echo "Docs: https://vercel.com/docs/deployments/environments, https://vercel.com/docs/projects/environment-variables"

echo ""
echo "To trigger deploys:"
echo "  git push origin staging  # → Preview"
echo "  git push origin main     # → Production"
echo "Or: vercel --prebuilt --target preview --git-branch staging"

echo ""
echo "For Neon direct migrations (never commit):"
echo "  export DATABASE_URL='<NEON_DIRECT_URL>' && npx drizzle-kit migrate"
echo "  node scripts/check-setup.mjs staging --strict"
