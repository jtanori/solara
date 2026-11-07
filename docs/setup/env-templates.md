# Env templates — `.env.staging` / `.env.production`

Two ready-to-copy templates are in the repo root (gitignored):

- `.env.staging.example` → copy to `.env.staging`
- `.env.production.example` → copy to `.env.production`

```bash
cp .env.staging.example .env.staging      # edit with your Neon pooled URL + staging APP_URL + Stripe test keys
cp .env.production.example .env.production # edit with prod pooler + prod APP_URL + Stripe live keys

# verify before uploading (format-only, never prints values)
node scripts/check-setup.mjs staging --strict   # with .env.staging exported or DATABASE_URL/APP_URL in shell
node scripts/check-setup.mjs production --strict
```

**Vercel upload:**

- **Via CLI:**
  ```bash
  vercel link --project solara
  # for staging (Preview, branch staging)
  vercel env pull .env.staging --environment preview --git-branch staging  # or:
  # open each var → vercel env add DATABASE_URL preview (paste pooled URL, scope to staging)
  # for production
  vercel env add DATABASE_URL production  # paste prod pooler, scope to main
  vercel env add APP_URL production
  ```

- **Via UI (recommended for first setup):** <https://vercel.com/dashboard> → Project → Settings → Environment Variables → Add → pick **Preview** (branch `staging`) for staging vars, **Production** for prod vars. Paste the values from your local `.env.staging` / `.env.production`.

**Important:**

- `DATABASE_URL` in Vercel is always the **pooled** Neon URL (`-pooler.` + `?sslmode=require`). Keep the **direct** (non-pooler) URL only in your secure migration shell, never in Vercel.
- `NEXT_PUBLIC_*` vars are baked into the build — redeploy after changing them.
- Never set `ALLOW_LOCAL_SEED*` or `LOCAL_SEED_PASSWORD` in Vercel — the app refuses them when `VERCEL` is set.
