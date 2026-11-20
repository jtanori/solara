import { build } from "esbuild";
import { cp, mkdir, readdir, rename, rm, writeFile } from "node:fs/promises";
import { open } from "node:fs/promises";
import { resolve } from "node:path";

// A standalone, credential-free Node process, not a Next server bundle. The
// bundle contains its dependencies, so runtime fs permissions only need .pdf/.
const output = resolve(".pdf");
await mkdir(output, { recursive: true });

/**
 * One builder at a time, via a lock file.
 *
 * `node --test` runs each *file* in its own process, and four suites (`pdf`,
 * `paid-presentation`, `paid-readings`, `readings-wheel-pdf`) each run this script in a
 * `before()`, so up to four build concurrently on the same `.pdf/`. Attempts to make each
 * individual step individually safe (atomic rename of the bundle, staged copies of the
 * assets) fixed the data corruption but not the *coordination*: concurrent `rm`+`rename` of
 * the same directory name still destroys a file another builder is publishing, and even six
 * builders regressed to one failure per few rounds.
 *
 * The honest fix is to not build concurrently at all. The work is ~0.5s, so serialising it
 * costs a few hundred milliseconds per suite and removes an entire class of failure. Every
 * builder also publishes the same bytes for the same sources, so there is nothing to gain
 * from parallelism here.
 *
 * The lock is a file created with `wx` (exclusive create), which is atomic; a stale lock —
 * a builder killed with SIGKILL — is broken by age, and the whole lock is bounded by a
 * timeout so a wedged build cannot hang the suite forever.
 */
const LOCK = `${output}/.build.lock`;
const LOCK_STALE_MS = 60_000;
const LOCK_WAIT_MS = 120_000;
async function acquire() {
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      const handle = await open(LOCK, "wx");
      await handle.writeFile(String(process.pid));
      await handle.close();
      return;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      try {
        const { mtimeMs } = await import("node:fs/promises").then(fs => fs.stat(LOCK));
        if (Date.now() - mtimeMs > LOCK_STALE_MS) { await rm(LOCK, { force: true }); continue; }
      } catch { continue; }
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${LOCK}`);
      await new Promise(settle => setTimeout(settle, 25));
    }
  }
}
await acquire();
try {
  await buildAndPublish();
} finally {
  await rm(LOCK, { force: true });
}

/**
 * Build in place now that no other builder is running.
 *
 * With the lock held, the direct `outfile` is correct again — there is no reader/writer race
 * to defend against, because no other builder is writing. The write order still publishes the
 * bundle last, so a *reader* that is not a builder (a forked worker from another suite) sees
 * either the previous bundle or the new one for as long as the rename-free copy takes. The
 * window is a few hundred milliseconds and the bundle is copied by esbuild in one pass; the
 * lock is what makes it correct, not the rename.
 */
async function buildAndPublish() {
  // Clear anything a killed builder left behind. With the lock held this cannot race.
  for (const name of await readdir(output)) {
    if (/\.tmp$/.test(name) || /^worker\.mjs\.\d+\.tmp\.LEGAL\.txt$/.test(name)) {
      await rm(`${output}/${name}`, { recursive: true, force: true });
    }
  }
  const temporary = `${output}/worker.mjs.${process.pid}.tmp`;
  await build({
    entryPoints: ["src/readings/pdf-worker.ts"], outfile: temporary,
    bundle: true, platform: "node", target: "node22", format: "esm",
    define: { "process.env.NODE_ENV": '"production"' },
    banner: { js: 'import { createRequire as __createRequire } from "node:module"; import { fileURLToPath as __fileURLToPath } from "node:url"; import { dirname as __dirnameOf } from "node:path"; const require = __createRequire(import.meta.url); const __filename = __fileURLToPath(import.meta.url); const __dirname = __dirnameOf(__filename);' },
    legalComments: "linked", logLevel: "warning",
  });
  // esbuild writes a `<outfile>.LEGAL.txt` sidecar for the linked legal comments; publish it
  // before the bundle so the package never has code without its license.
  await rm(`${output}/worker.mjs.LEGAL.txt`, { force: true });
  await rename(`${temporary}.LEGAL.txt`, `${output}/worker.mjs.LEGAL.txt`);
  await rename(temporary, `${output}/worker.mjs`);

await cp("src/readings/pdf-bootstrap.mjs", `${output}/bootstrap.mjs`);
await cp("src/readings/fonts", `${output}/fonts`, { recursive: true, force: true });
// PDFKit registers its builtin metrics lazily via createRequire/imports, even
// when all visible text uses our embedded font. Preserve that private mapping.
await cp("node_modules/pdfkit/js/standard-fonts", `${output}/standard-fonts`, { recursive: true, force: true });
await writeFile(`${output}/package.json`, JSON.stringify({ private: true, type: "module", imports: { "#standard-fonts/*": "./standard-fonts/*.cjs" } }));
await mkdir(`${output}/data`, { recursive: true });
  await cp("node_modules/pdfkit/js/data/sRGB_IEC61966_2_1.icc", `${output}/data/sRGB_IEC61966_2_1.icc`, { force: true });
}
