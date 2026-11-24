import { defineConfig, globalIgnores } from "eslint/config";
import nextCoreWebVitals from "eslint-config-next/core-web-vitals";

export default defineConfig([
  // Keep the starter on the flat config export that actually runs under the pinned ESLint/Next toolchain.
  ...nextCoreWebVitals,
  {
    files: ["src/**/*.{ts,tsx}"],
    rules: { "no-console": "error" },
  },
  {
    files: ["src/lib/log.ts"],
    rules: { "no-console": "off" },
  },
  // Upstream CommonJS is kept byte-for-byte except for the documented backport;
  // dependency-security.test.ts verifies its provenance and security behavior.
  globalIgnores(["vendor/**", ".next/**", ".pdf/**", ".venv/**", "out/**", "build/**", "next-env.d.ts"]),
]);
