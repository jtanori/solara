import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import test from "node:test";

test("setup checker keeps values private and distinguishes test from live Stripe keys",()=>{
  const suffix=randomBytes(12).toString("hex");
  const secret=`sk_test_${suffix}`;const webhook=`whsec_${suffix}`;
  const env={...process.env,DATABASE_URL:"postgresql://localhost/example",APP_URL:"http://localhost:3000",STRIPE_SECRET_KEY:secret,STRIPE_WEBHOOK_SECRET:webhook,STRIPE_PRICE_ID_MXN:`price_${suffix}`,STRIPE_PRICE_ID_USD:"",STRIPE_PREMIUM_PRICE_IDS:"",OPEN_METEO_API_KEY:"",NEXT_PUBLIC_MAP_TILE_URL:"",NEXT_PUBLIC_MAP_ATTRIBUTION:""};
  const local=spawnSync(process.execPath,["scripts/check-setup.mjs","local","--strict"],{env,encoding:"utf8"});
  assert.equal(local.status,0,local.stdout+local.stderr);assert.ok(!local.stdout.includes(secret));assert.ok(!local.stdout.includes(webhook));
  const production=spawnSync(process.execPath,["scripts/check-setup.mjs","production","--strict"],{env:{...env,APP_URL:"https://example.invalid",DATABASE_URL:"postgresql://db.example.invalid/example?sslmode=require"},encoding:"utf8"});
  assert.equal(production.status,1);assert.match(production.stdout,/must use a live key/);assert.ok(!production.stdout.includes(secret));
});

// The database identity guard (#168) fails closed at boot, but nothing enforced its
// requirements until this check existed — a missing endpoint label passed every gate
// and only surfaced on a production deploy. These pin the checker to the guard.
test("setup checker enforces the database endpoint label that the guard requires",()=>{
  const base:Record<string,string|undefined>={...process.env,DATABASE_URL:"postgresql://u:p@ep-tiny-butterfly-beoceifb-pooler.us-east-2.aws.neon.tech/db?sslmode=verify-full",APP_URL:"https://example.invalid",MAIL_TRANSPORT:"resend",MAIL_FROM:"Solara <no-reply@example.invalid>",RESEND_API_KEY:"re_test",APP_DEPLOY_ENV:"production"};
  const noEndpoint={...base};delete noEndpoint.PROD_DB_ENDPOINT;delete noEndpoint.STAGING_DB_ENDPOINT;
  const run=(env:Record<string,string|undefined>)=>spawnSync(process.execPath,["scripts/check-setup.mjs","production"],{env:env as NodeJS.ProcessEnv,encoding:"utf8"});

  const missing=run(noEndpoint);
  assert.match(missing.stdout,/PROD_DB_ENDPOINT is required for production/);

  const matching=run({...base,PROD_DB_ENDPOINT:"ep-tiny-butterfly-beoceifb"});
  assert.match(matching.stdout,/PROD_DB_ENDPOINT matches the DATABASE_URL endpoint label/);

  // The value the docs warn about: a pooled placeholder that never matched reality.
  const stale=run({...base,PROD_DB_ENDPOINT:"ep-yyy"});
  assert.match(stale.stdout,/PROD_DB_ENDPOINT does not match the endpoint in DATABASE_URL/);

  const malformed=run({...base,PROD_DB_ENDPOINT:"EP_BAD!"});
  assert.match(malformed.stdout,/must be a Neon endpoint label/);
});
