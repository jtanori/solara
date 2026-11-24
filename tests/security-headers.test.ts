import assert from "node:assert/strict";
import test from "node:test";
import {
  buildCsp,
  cspHeaderName,
  resolveCspMode,
  staticSecurityHeaders,
} from "../src/lib/security-headers";

const baseEnv = {
  APP_URL: "https://solara-stg.vercel.app",
  VERCEL_ENV: "preview",
  NODE_ENV: "production",
};

test("sets the baseline security headers", () => {
  const headers = new Map(staticSecurityHeaders(baseEnv).map(({ key, value }) => [key, value]));
  assert.equal(headers.get("X-Content-Type-Options"), "nosniff");
  assert.equal(headers.get("X-Frame-Options"), "DENY");
  assert.equal(headers.get("Referrer-Policy"), "strict-origin-when-cross-origin");
  assert.equal(headers.get("Permissions-Policy"), "camera=(), microphone=(), geolocation=()");
  assert.equal(headers.get("Cross-Origin-Opener-Policy"), "same-origin");
  assert.equal(headers.get("Cross-Origin-Resource-Policy"), "same-origin");
  assert.equal(headers.get("X-DNS-Prefetch-Control"), "off");
  assert.equal(headers.get("X-Permitted-Cross-Domain-Policies"), "none");
});

test("sets HSTS only in production", () => {
  const staging = new Map(staticSecurityHeaders(baseEnv).map(({ key, value }) => [key, value]));
  assert.equal(staging.has("Strict-Transport-Security"), false);

  const production = new Map(
    staticSecurityHeaders({ ...baseEnv, VERCEL_ENV: "production" }).map(({ key, value }) => [key, value]),
  );
  assert.equal(
    production.get("Strict-Transport-Security"),
    "max-age=63072000; includeSubDomains; preload",
  );
});

test("uses report-only by default and enforce only when requested", () => {
  assert.equal(resolveCspMode({}), "report-only");
  assert.equal(resolveCspMode({ CSP_MODE: "report-only" }), "report-only");
  assert.equal(resolveCspMode({ CSP_MODE: "enforce" }), "enforce");
  assert.equal(cspHeaderName("report-only"), "Content-Security-Policy-Report-Only");
  assert.equal(cspHeaderName("enforce"), "Content-Security-Policy");
});

test("builds a nonce-based CSP with the expected allowlist", () => {
  const csp = buildCsp({
    nonce: "test-nonce",
    isDev: false,
    appUrl: "https://solara-stg.vercel.app",
    mapTileUrl: "https://tiles.example.com/{z}/{x}/{y}.png",
  });

  assert.match(csp, /script-src 'self' 'nonce-test-nonce' 'strict-dynamic'/);
  assert.match(csp, /style-src-attr 'unsafe-inline'/);
  assert.match(csp, /img-src 'self' blob: data: .*https:\/\/tiles\.example\.com/);
  assert.match(csp, /font-src 'self' https:\/\/fonts\.gstatic\.com data:/);
  assert.match(csp, /frame-ancestors 'none'/);
  assert.match(csp, /report-uri \/api\/csp-report/);
  assert.match(csp, /upgrade-insecure-requests/);
  assert.doesNotMatch(csp, /script-src[^;]*'unsafe-inline'/);
});

test("adds development-only eval and websocket allowances", () => {
  const csp = buildCsp({
    nonce: "dev-nonce",
    isDev: true,
    appUrl: "http://localhost:3000",
    mapTileUrl: undefined,
  });

  assert.match(csp, /'unsafe-eval'/);
  assert.match(csp, /connect-src 'self' ws: wss:/);
  assert.doesNotMatch(csp, /upgrade-insecure-requests/);
});
