import "dotenv/config";

const profile = process.argv[2] || "local";
const strict = process.argv.includes("--strict");
if (!["local", "staging", "production"].includes(profile)) {
  console.error("Usage: node scripts/check-setup.mjs <local|staging|production> [--strict]");
  process.exit(2);
}
let errors = 0;
let warnings = 0;
function report(level, message) {
  if (level === "ERROR") errors++;
  if (level === "WARN") warnings++;
  console.log(`${level.padEnd(5)} ${message}`);
}
function value(name) { return process.env[name]?.trim() || ""; }
console.log(`Solara configuration check: ${profile}. Values are never printed.`);
const database = value("DATABASE_URL");
try {
  if (!database) throw new Error("missing");
  const url = new URL(database);
  if (!["postgres:", "postgresql:"].includes(url.protocol) || !url.hostname) throw new Error("invalid");
  report("OK", "DATABASE_URL is present and has a PostgreSQL URL format.");
  if (profile !== "local" && ["localhost", "127.0.0.1", "::1"].includes(url.hostname)) report("WARN", "Hosted environments normally need their own reachable database, not localhost.");
  if (profile !== "local" && !url.searchParams.has("sslmode")) report("WARN", "Confirm TLS is enforced for the hosted database connection.");
} catch { report("ERROR", "DATABASE_URL is missing or is not a valid PostgreSQL URL."); }
const appUrl = value("APP_URL");
if (!appUrl) report(profile === "local" ? "WARN" : "ERROR", "APP_URL is missing; set the canonical origin for Stripe redirects.");
else {
  try {
    const url = new URL(appUrl);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new Error("invalid");
    if (profile !== "local" && url.protocol !== "https:") report("ERROR", "APP_URL must use HTTPS for hosted environments.");
    else report("OK", "APP_URL has an appropriate URL format.");
    if (url.pathname !== "/" || url.search || url.hash) report("WARN", "APP_URL should be an origin only; paths and query strings are ignored.");
  } catch { report("ERROR", "APP_URL is not a valid HTTP(S) origin."); }
}
const stripeKey = value("STRIPE_SECRET_KEY");
const webhook = value("STRIPE_WEBHOOK_SECRET");
const mxn = value("STRIPE_PRICE_ID_MXN");
if (!stripeKey || !webhook || !mxn) report(profile === "local" ? "WARN" : "ERROR", "Stripe is incomplete: secret key, webhook secret, and MXN recurring price ID are required for checkout.");
if (stripeKey) {
  const expected = profile === "production" ? /^(sk|rk)_live_/ : /^(sk|rk)_test_/;
  if (expected.test(stripeKey)) report("OK", `STRIPE_SECRET_KEY has the expected ${profile === "production" ? "live" : "test"} mode prefix.`);
  else report("ERROR", `STRIPE_SECRET_KEY must use a ${profile === "production" ? "live" : "test"} key for this profile.`);
}
if (webhook) {
  if (webhook.startsWith("whsec_")) report("OK", "STRIPE_WEBHOOK_SECRET has the expected format.");
  else report("ERROR", "STRIPE_WEBHOOK_SECRET must be the signing secret for this endpoint.");
}
for (const name of ["STRIPE_PRICE_ID_MXN", "STRIPE_PRICE_ID_USD"]) {
  const price = value(name);
  if (price && !price.startsWith("price_")) report("ERROR", `${name} must be a Stripe Price ID.`);
  else if (price) report("OK", `${name} has the expected format.`);
}
const legacy = value("STRIPE_PREMIUM_PRICE_IDS").split(",").map(x => x.trim()).filter(Boolean);
if (legacy.some(price => !price.startsWith("price_"))) report("ERROR", "Each legacy Premium price must be a Stripe Price ID.");
if (!value("OPEN_METEO_API_KEY")) {
  if (profile === "production") report("WARN", "Production commercial geocoding requires an appropriate Open-Meteo license and customer key.");
  else report("OK", "Open-Meteo public geocoding is available for non-commercial evaluation.");
} else report("OK", "OPEN_METEO_API_KEY is present; customer geocoding will be used.");
const tiles = value("NEXT_PUBLIC_MAP_TILE_URL");
if (tiles) {
  if (!tiles.startsWith("https://") || !["{z}", "{x}", "{y}"].every(part => tiles.includes(part))) report("ERROR", "NEXT_PUBLIC_MAP_TILE_URL must be an HTTPS template containing {z}, {x}, and {y}.");
  else report("OK", "A public map-tile URL template is configured.");
  if (!value("NEXT_PUBLIC_MAP_ATTRIBUTION")) report("WARN", "Add the tile provider's required attribution as plain text.");
} else if (profile === "production") report("WARN", "Default OpenStreetMap tiles have limited capacity; choose an appropriate production provider and verify its policy.");
else report("OK", "The default OpenStreetMap tile endpoint is used for evaluation.");
console.log("This is a format check only: it does not connect to providers, verify licenses, or confirm webhook delivery.");
if (errors || (strict && warnings)) process.exitCode = 1;
