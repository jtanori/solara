import { build } from "esbuild";
import { cp, mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

// A standalone, credential-free Node process, not a Next server bundle. The
// bundle contains its dependencies, so runtime fs permissions only need .pdf/.
const output = resolve(".pdf");
await mkdir(output, { recursive: true });
await build({
  entryPoints: ["src/readings/pdf-worker.ts"], outfile: `${output}/worker.mjs`,
  bundle: true, platform: "node", target: "node22", format: "esm",
  define: { "process.env.NODE_ENV": '"production"' },
  banner: { js: 'import { createRequire as __createRequire } from "node:module"; import { fileURLToPath as __fileURLToPath } from "node:url"; import { dirname as __dirnameOf } from "node:path"; const require = __createRequire(import.meta.url); const __filename = __fileURLToPath(import.meta.url); const __dirname = __dirnameOf(__filename);' },
  legalComments: "linked", logLevel: "warning",
});
await cp("src/readings/pdf-bootstrap.mjs", `${output}/bootstrap.mjs`);
await cp("src/readings/fonts", `${output}/fonts`, { recursive: true });
// PDFKit registers its builtin metrics lazily via createRequire/imports, even
// when all visible text uses our embedded font. Preserve that private mapping.
await cp("node_modules/pdfkit/js/standard-fonts", `${output}/standard-fonts`, { recursive: true });
await writeFile(`${output}/package.json`, JSON.stringify({ private: true, type: "module", imports: { "#standard-fonts/*": "./standard-fonts/*.cjs" } }));
await mkdir(`${output}/data`, { recursive: true });
await cp("node_modules/pdfkit/js/data/sRGB_IEC61966_2_1.icc", `${output}/data/sRGB_IEC61966_2_1.icc`);
