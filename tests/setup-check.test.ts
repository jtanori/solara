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
