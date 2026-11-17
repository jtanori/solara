import { mkdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { brotliDecompressSync } from "node:zlib";
import { execFileSync } from "node:child_process";
import chromium from "@sparticuz/chromium";
import { chromium as playwright } from "playwright-core";

/** Pinned npm-distributed Linux browser; no external download or system install.
 * Minimal sandboxes need the NSS/NSPR libraries shipped in the same package.
 * Do NOT inherit Lambda's web-security/site-isolation bypass flags in QA.
 */
export async function launchReadingTestBrowser() {
  const libraries = resolve(".venv/reading-browser-libs"); mkdirSync(libraries, { recursive: true });
  execFileSync("tar", ["-xf", "-", "-C", libraries], { input: brotliDecompressSync(readFileSync("node_modules/@sparticuz/chromium/bin/al2023.tar.br")) });
  return playwright.launch({ executablePath: await chromium.executablePath(), headless: true,
    args: chromium.args.filter(arg => !["--disable-web-security", "--allow-running-insecure-content", "--disable-site-isolation-trials", "--single-process"].includes(arg) && !arg.includes("IsolateOrigins")),
    env: { ...process.env, LD_LIBRARY_PATH: `${libraries}/lib:${process.env.LD_LIBRARY_PATH ?? ""}` },
  });
}
