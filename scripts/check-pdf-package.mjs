import assert from "node:assert/strict";
import { readFileSync, existsSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";

const trace = resolve(".next/server/app/api/readings/[id]/pdf/route.js.nft.json");
const files = JSON.parse(readFileSync(trace, "utf8")).files.map(file => resolve(dirname(trace), file));
for (const asset of ["bootstrap.mjs", "worker.mjs", "worker.mjs.LEGAL.txt", "package.json", "standard-fonts/Helvetica.cjs", "data/sRGB_IEC61966_2_1.icc", "fonts/LICENSE", "fonts/noto-sans-latin-400-normal.woff", "fonts/noto-sans-latin-700-normal.woff", "fonts/noto-sans-latin-400-italic.woff"]) {
  const path = resolve(".pdf", asset); assert.ok(files.includes(path) && existsSync(path), `missing traced PDF asset: ${asset}`);
}
const prohibited = files.filter(file => /\/(?:tests|\.venv|\.env(?:\.[^/]+)?)(?:\/|$)/.test(file) || /node_modules\/(?:playwright|@sparticuz|pdfjs-dist|@napi-rs)/.test(file));
assert.equal(prohibited.length, 0, "test data/browser/extractor must not enter the deployed PDF function");
const total = files.filter(file => existsSync(file) && statSync(file).isFile()).reduce((sum, file) => sum + statSync(file).size, 0);
console.log(`PDF package trace: ${files.length} files, ${(total / 1024 / 1024).toFixed(1)} MiB; worker/fonts/metrics/license present, no test/browser/extractor files.`);
