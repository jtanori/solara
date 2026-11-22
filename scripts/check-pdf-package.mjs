import assert from "node:assert/strict";
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";

const trace = resolve(".next/server/app/api/readings/[id]/pdf/route.js.nft.json");
const files = JSON.parse(readFileSync(trace, "utf8")).files.map(file => resolve(dirname(trace), file));
for (const asset of ["bootstrap.mjs", "worker.mjs", "worker.mjs.LEGAL.txt", "package.json", "standard-fonts/Helvetica.cjs", "data/sRGB_IEC61966_2_1.icc", "fonts/LICENSE", "fonts/noto-sans-latin-400-normal.woff", "fonts/noto-sans-latin-700-normal.woff", "fonts/noto-sans-latin-400-italic.woff"]) {
  const path = resolve(".pdf", asset); assert.ok(files.includes(path) && existsSync(path), `missing traced PDF asset: ${asset}`);
}
// The bundle's own legal footer names a file. That name is easy to break and impossible to
// notice by reading the script: esbuild derives it from the outfile it was given, so building
// from a temporary path ships a footer pointing at a file the build then renames away. This
// asserts the *named* sidecar exists in the shipped package, rather than that some legal file
// does. The packager must also trace it, or the deployed function carries a dangling reference.
const worker = resolve(".pdf/worker.mjs");
const footer = readFileSync(worker, "utf8").match(/For license information please see (\S+?) \*\//);
assert.ok(footer, "the worker states where its license text lives");
const linked = resolve(dirname(worker), footer[1]);
assert.ok(existsSync(linked), `the worker links to a license file that exists: ${footer[1]}`);
assert.ok(files.includes(linked), `the linked license file is traced for deployment: ${footer[1]}`);

// The trace glob is a glob over the whole directory, so comparing it against what is on disk
// cannot detect debris: a stale file sitting in `.pdf/` when the build runs is swept into the
// trace, and the two sets then agree *with the debris in both*. That is how 47 stale legal
// sidecars once shipped. The comparison is therefore against the manifest the build wrote when it
// published, which lives outside the traced directory. Missing manifest = the check cannot
// prove anything, so it fails rather than falling back to disk.
const manifestPath = resolve(".venv/pdf-build/published.json");
assert.ok(existsSync(manifestPath), `the build wrote a published manifest: ${manifestPath}`);
const published = JSON.parse(readFileSync(manifestPath, "utf8")).map(relative => resolve(".pdf", relative)).sort();
const traced = files.filter(file => file.startsWith(resolve(".pdf") + "/")).sort();
assert.deepEqual(traced, published,
  "the traced .pdf files are exactly the ones the build published (not merely what is on disk)");

const prohibited = files.filter(file => /\/(?:tests|\.venv|\.env(?:\.[^/]+)?)(?:\/|$)/.test(file) || /node_modules\/(?:playwright|@sparticuz|pdfjs-dist|@napi-rs)/.test(file));
assert.equal(prohibited.length, 0, "test data/browser/extractor must not enter the deployed PDF function");
const total = files.filter(file => existsSync(file) && statSync(file).isFile()).reduce((sum, file) => sum + statSync(file).size, 0);
console.log(`PDF package trace: ${files.length} files, ${(total / 1024 / 1024).toFixed(1)} MiB; worker/fonts/metrics/license present, no test/browser/extractor files.`);
