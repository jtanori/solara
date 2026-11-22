import { build } from "esbuild";
import { cp, link, mkdir, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { open } from "node:fs/promises";
import { resolve } from "node:path";

// A standalone, credential-free Node process, not a Next server bundle. The
// bundle contains its dependencies, so runtime fs permissions only need .pdf/.
const output = resolve(".pdf");
await mkdir(output, { recursive: true });

/**
 * This directory is read and written by two populations that need different guarantees.
 *
 * **Builders against builders.** `node --test` runs each *file* in its own process, and four
 * suites (`pdf`, `paid-presentation`, `paid-readings`, `readings-wheel-pdf`) each run this
 * script in a `before()`. Per-step atomicity did not fix that: concurrent `rm`+`rename` of the
 * same name still destroys a peer's work, and six builders regressed to one failure per few
 * rounds. The lock below serialises builders; the work is ~1s, so this is cheap.
 *
 * **Builders against readers.** A *reader* is any forked worker — `bootstrap.mjs` →
 * `worker.mjs` — started by the app or by another test file. **Readers do not take the lock
 * and must not need to.** So instead of replacing the package as a whole (which no filesystem
 * offers atomically for a directory), the invariant is per file:
 *
 *     No reader-resolvable path is ever open for writing. Every published file is complete.
 *
 * The package is built in a private staging directory outside the deployment trace, then each
 * file is moved into place with `rename`, which is atomic *and* overwrites. A reader that
 * resolves `fonts/HelveticaBold.mjs` before the swap reads the complete old file; one that
 * resolves after it reads the complete new one. There is no state in which it reads half of
 * either. `worker.mjs` is published **last**, so a reader that sees the new bundle always sees
 * the assets it expects.
 *
 * The one thing this does not provide is a single atomic swap of the whole package, so
 * "bundle from build N with a font from build N−1" is possible for a few microseconds. That is
 * harmless here because asset bytes are a function of the sources, not of the build: two builds
 * of the same checkout publish identical assets, and a build after a source change republishes
 * both. It is a narrower claim than "atomic package" and it is the one the code actually makes.
 *
 * Staging lives in `.venv/pdf-build/` — repository-internal so `rename` stays on one filesystem,
 * and outside `.pdf/**\/*` so a published package never contains build scaffolding.
 */
const LOCK = `${output}/.build.lock`;
const STAGING_ROOT = resolve(".venv/pdf-build");
const LOCK_WAIT_MS = Number(process.env.PDF_BUILD_LOCK_WAIT_MS ?? 300_000);

/**
 * Ownership-safe mutual exclusion.
 *
 * The winner writes its pid into a private blob and `link`s it into place. `link` is the
 * primitive that matters here: it is atomic **and** fails with `EEXIST` when the target exists.
 * `open(LOCK, "wx")` would be atomic too, but it publishes an empty file for the microseconds
 * between create and write; `rename` publishes the content at once but silently *overwrites* a
 * held lock, which defeats the lock entirely. `link` gives both properties, and the lock is
 * therefore never observed empty and never replaced by a contender.
 *
 * A lock is reclaimed only when its holder is **proven dead** — `kill(pid, 0)` says the pid no
 * longer exists — never by age alone. Age cannot distinguish a builder that was SIGKILLed from
 * a live builder whose clock or machine is slow, and the previous age-based version could evict
 * a live holder mid-critical-section; a review reproduced exactly that by aging the mtime of a
 * paused builder.
 *
 * Reclaim and release are **not** "check the owner, then unlink by name": that is a race with no
 * primitive that closes it. Two contenders can both verify the same dead lock, the first unlinks
 * and `link`s a successor, and the second's already-decided unlink deletes the *successor's live
 * lock*. Instead the reclaim is a `rename` of `LOCK` to a name only this process can create:
 * exactly one contender can move the file, the loser gets `ENOENT`, and the winner then inspects
 * what it moved. If it is not the dead lock we meant to remove, it is a successor's live lock and
 * it is put back with `link` (ignoring `EEXIST`, which means someone already re-acquired).
 * Release uses the same rename-to-quarantine, so it can only ever remove a lock it moved itself.
 */
async function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === "EPERM"; }
}

async function readLock() {
  let handle;
  try {
    handle = await open(LOCK, "r");
    // `handle.stat()` rather than `stat(LOCK)`: pairing an inode read before the open with a pid
    // read after it can describe two different files if the lock is replaced in between.
    const { ino } = await handle.stat();
    const pid = Number.parseInt(String(await handle.readFile()), 10);
    return { pid: Number.isFinite(pid) ? pid : null, ino };
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  } finally {
    await handle?.close();
  }
}

/**
 * Move the current lock aside under a name only this process can create, then look at what was
 * moved. Exactly one contender wins the rename; a loser sees `ENOENT` and retries the loop.
 *
 * Returns the quarantine's contents, or null if the lock vanished first.
 */
async function quarantineLock(tag) {
  const quarantine = `${LOCK}.${tag}.${process.pid}`;
  await rm(quarantine, { force: true });
  try {
    await rename(LOCK, quarantine);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
  const handle = await open(quarantine, "r");
  try {
    const { ino } = await handle.stat();
    const pid = Number.parseInt(String(await handle.readFile()), 10);
    return { quarantine, pid: Number.isFinite(pid) ? pid : null, ino };
  } finally {
    await handle.close();
  }
}

/** Put a quarantined lock back. `EEXIST` means a successor already re-acquired; that one stays. */
async function restoreLock(moved) {
  await link(moved.quarantine, LOCK).catch(error => { if (error.code !== "EEXIST") throw error; });
  await rm(moved.quarantine, { force: true });
}

async function acquire() {
  const deadline = Date.now() + LOCK_WAIT_MS;
  let reason = "no attempt recorded";
  for (;;) {
    // The deadline is checked at the top of *every* iteration, so no retry path can bypass it,
    // and every path below sleeps the same interval rather than spinning on a hot loop.
    if (Date.now() > deadline) {
      throw new Error(`timed out after ${LOCK_WAIT_MS}ms waiting for ${LOCK} (${reason})`);
    }
    const candidate = `${LOCK}.${process.pid}`;
    try {
      const handle = await open(candidate, "wx");
      await handle.writeFile(String(process.pid));
      await handle.close();
      await link(candidate, LOCK);   // EEXIST if someone else won; atomic, never clobbers
      await rm(candidate, { force: true });
      return;
    } catch (error) {
      await rm(candidate, { force: true });
      if (error.code !== "EEXIST") throw error;
    }

    const held = await readLock();
    if (held === null) {
      reason = `lock ${LOCK} disappeared between attempts`;
    } else if (held.pid === process.pid) {
      return; // our own lock, from an earlier phase
    } else if (held.pid !== null && !(await alive(held.pid))) {
      // The owner is proven dead. Claim the file atomically rather than unlinking it by name.
      const moved = await quarantineLock("reclaim");
      if (moved === null) {
        reason = `lock ${LOCK} disappeared while reclaiming it`;
      } else if (moved.pid === held.pid && moved.ino === held.ino) {
        await rm(moved.quarantine, { force: true });
        continue; // the stale lock is gone; retry the acquisition immediately
      } else {
        // Something re-acquired between our read and our rename. It is live; put it back.
        await restoreLock(moved);
        reason = `lock ${LOCK} was re-acquired while reclaiming it`;
      }
    } else {
      reason = held.pid === null ? `lock ${LOCK} has no readable owner` : `held by live pid ${held.pid}`;
    }

    await new Promise(settle => setTimeout(settle, 25));
  }
}

/**
 * Release by moving our own lock aside — never by unlinking the name.
 *
 * A blind `finally` unlink can delete a successor's lock; so can a check-then-unlink, because the
 * successor can acquire between the check and the unlink. The rename only succeeds if the lock
 * this process moved is the one that was there, and the contents decide whether it was ours.
 */
async function release() {
  const moved = await quarantineLock("release");
  if (moved === null) return;
  if (moved.pid === process.pid) await rm(moved.quarantine, { force: true });
  else await restoreLock(moved); // not ours after all; give it back
}

await acquire();
try {
  await buildAndPublish();
} finally {
  await release();
}

/**
 * Build one complete package in private staging, then publish it file by file.
 *
 * Three defects fixed here, each reproduced independently by review:
 *
 * 1. **The shipped bundle named a license file that could not exist.** esbuild appends
 *    `For license information please see <outfile>.LEGAL.txt`, using the outfile it was given.
 *    Building to `worker.mjs.<pid>.tmp` shipped a footer naming
 *    `worker.mjs.<pid>.tmp.LEGAL.txt` — a name this script then renamed away. The bundle is now
 *    built under its **final basename** in staging, so the emitted footer is correct verbatim
 *    and names the sidecar published beside it.
 * 2. **In-place copies exposed a torn package.** `package.json` was truncated and rewritten at
 *    the live path, so a reader could hit `ERR_INVALID_PACKAGE_CONFIG`; fonts and metrics were
 *    copied over live names. Now nothing is written at a reader-resolvable path.
 * 3. **Publication order was claimed but not enforced.** The worker is now published last, and
 *    `tests/readings-wheel-pdf.test.ts` launches a real worker while publication is paused
 *    rather than sampling a length after the fact.
 */
async function buildAndPublish() {
  // Clear anything a killed builder left behind. Safe: the lock is held.
  await rm(STAGING_ROOT, { recursive: true, force: true });
  for (const name of await readdir(output)) {
    if (/\.tmp$/.test(name) || /^worker\.mjs\.\d+\.tmp\.LEGAL\.txt$/.test(name)) {
      await rm(`${output}/${name}`, { recursive: true, force: true });
    }
  }

  const staging = `${STAGING_ROOT}/${process.pid}`;
  await mkdir(staging, { recursive: true });

  await build({
    entryPoints: ["src/readings/pdf-worker.ts"], outfile: `${staging}/worker.mjs`,
    bundle: true, platform: "node", target: "node22", format: "esm",
    define: { "process.env.NODE_ENV": '"production"' },
    banner: { js: 'import { createRequire as __createRequire } from "node:module"; import { fileURLToPath as __fileURLToPath } from "node:url"; import { dirname as __dirnameOf } from "node:path"; const require = __createRequire(import.meta.url); const __filename = __fileURLToPath(import.meta.url); const __dirname = __dirnameOf(__filename);' },
    legalComments: "linked", logLevel: "warning",
  });
  await cp("src/readings/pdf-bootstrap.mjs", `${staging}/bootstrap.mjs`);
  await cp("src/readings/fonts", `${staging}/fonts`, { recursive: true, force: true });
  // PDFKit registers its builtin metrics lazily via createRequire/imports, even
  // when all visible text uses our embedded font. Preserve that private mapping.
  await cp("node_modules/pdfkit/js/standard-fonts", `${staging}/standard-fonts`, { recursive: true, force: true });
  await writeFile(`${staging}/package.json`, JSON.stringify({ private: true, type: "module", imports: { "#standard-fonts/*": "./standard-fonts/*.cjs" } }));
  await mkdir(`${staging}/data`, { recursive: true });
  await cp("node_modules/pdfkit/js/data/sRGB_IEC61966_2_1.icc", `${staging}/data/sRGB_IEC61966_2_1.icc`, { force: true });

  await publish(staging);
  await rm(staging, { recursive: true, force: true });
}

/**
 * Publish staged files in place, one atomic `rename` each, bundle last.
 *
 * `rename` over an existing file replaces it atomically on POSIX: a reader with the old path
 * open keeps reading the old inode, and the new name appears complete or not at all.
 */
async function publish(staging) {
  const queue = [];
  const collect = async (path, prefix) => {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      if (entry.isDirectory()) await collect(`${path}/${entry.name}`, `${prefix}${entry.name}/`);
      else queue.push(`${prefix}${entry.name}`);
    }
  };
  await collect(staging, "");

  // The bundle goes last: whatever a reader has already loaded, the assets it may reference are
  // in place before the code that references them becomes visible.
  const ordered = [...queue.filter(file => file !== "worker.mjs"), "worker.mjs"];
  for (const file of ordered) {
    if (process.env.PDF_BUILD_TEST_PAUSE_FILE && file === "worker.mjs") {
      // Test-only hook: let a reader start while assets are new and the bundle is still old.
      await writeFile(process.env.PDF_BUILD_TEST_PAUSE_FILE, "publishing");
      await new Promise(settle => setTimeout(settle, Number(process.env.PDF_BUILD_TEST_PAUSE_MS ?? 1_000)));
    }
    const destination = `${output}/${file}`;
    await mkdir(destination.slice(0, destination.lastIndexOf("/")), { recursive: true });
    await rename(`${staging}/${file}`, destination);
  }
}
