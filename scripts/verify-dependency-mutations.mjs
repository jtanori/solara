import assert from "node:assert/strict";
import { spawnSync, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, renameSync, rmSync, symlinkSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";

// Local-only negative controls. Never change expectations or count a crash,
// import error or timeout as a kill. A clean checkpoint makes recovery explicit.
assert.equal(execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim(), "", "commit a clean checkpoint first");
const sourceSha = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
const require = createRequire(import.meta.url);
const root = process.cwd();
const folder = resolve(".venv/dependency-mutations");
mkdirSync(folder, { recursive: true });
const env = { ...process.env, DOTENV_CONFIG_PATH: "/dev/null", ESBK_DISABLE_CACHE: "1", NEXT_TELEMETRY_DISABLED: "1" };
const evidence = { sourceSha, mutations: [], restored: false, cleanRerun: false };
const digest = bytes => createHash("sha256").update(bytes).digest("hex");

function run(label, args, timeout = 30_000) {
  const result = spawnSync(args[0], args.slice(1), { env, encoding: "utf8", timeout, killSignal: "SIGKILL", maxBuffer: 4 * 1024 * 1024 });
  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  writeFileSync(join(folder, `${label}.log`), output);
  assert.equal(result.error, undefined, `${label}: ${result.error?.message}`);
  assert.equal(result.signal, null, `${label}: terminated by signal`);
  return { status: result.status, output };
}

const negative = join(folder, "negative-controls");
mkdirSync(negative, { recursive: true });
writeFileSync(join(negative, "package.json"), '{"private":true}\n');
const install = run("install-negative-controls", ["npm", "install", "--prefix", negative, "--ignore-scripts", "--no-audit", "--no-fund", "--save-exact", "minimatch@10.2.6", "esbuild@0.18.20"], 120_000);
assert.equal(install.status, 0, install.output);

const matcherRoot = dirname(require.resolve("picomatch"));
const parser = join(matcherRoot, "lib/parse.js");
const matcher = join(matcherRoot, "lib/picomatch.js");
const provenance = JSON.parse(readFileSync("vendor/picomatch-provenance.json", "utf8"));
const archive = resolve(provenance.packages[0].archive.path);
const fromEstree = createRequire(require.resolve("@typescript-eslint/typescript-estree"));
const fromKit = createRequire(require.resolve("drizzle-kit"));
const fromLoader = createRequire(fromKit.resolve("@esbuild-kit/esm-loader"));
const fromCore = createRequire(fromLoader.resolve("@esbuild-kit/core-utils"));
function packageRoot(entry, name) {
  let directory = dirname(entry);
  while (directory.startsWith(join(root, "node_modules"))) {
    try {
      if (JSON.parse(readFileSync(join(directory, "package.json"), "utf8")).name === name) return directory;
    } catch (error) { if (error.code !== "ENOENT") throw error; }
    directory = dirname(directory);
  }
  throw new Error(`could not locate installed ${name}`);
}
const minimatch = packageRoot(fromEstree.resolve("minimatch"), "minimatch");
const esbuild = packageRoot(fromCore.resolve("esbuild"), "esbuild");
const ignore = resolve(".vercelignore");
const originals = new Map([parser, matcher, archive, ignore].map(path => [path, readFileSync(path)]));
for (const [path, bytes] of originals) writeFileSync(join(folder, `${path.replaceAll("/", "_")}.backup`), bytes);
let restoreDirectory = () => {};
function restore() {
  restoreDirectory();
  restoreDirectory = () => {};
  for (const [path, bytes] of originals) writeFileSync(path, bytes);
}
for (const signal of ["SIGTERM", "SIGINT"]) process.once(signal, () => { restore(); process.exit(1); });
function edit(path, from, to) {
  const content = readFileSync(path, "utf8");
  assert.equal(content.split(from).length, 2, `${path}: mutation target must be unique`);
  writeFileSync(path, content.replace(from, to));
}
function downgrade(path, name) {
  const backup = join(folder, `${name}-installed-backup`);
  renameSync(path, backup);
  restoreDirectory = () => { rmSync(path, { recursive: true, force: true }); renameSync(backup, path); };
  // A realpath into the isolated install also selects its matching native
  // esbuild binary, rather than producing a false API/binary-mismatch "kill".
  symlinkSync(join(negative, "node_modules", name), path, "dir");
}
const literalTest = "micromatch uses the patched matcher";
const mutations = [
  ["removed-repeated-star-guard", () => {
    const text = readFileSync(parser, "utf8");
    const start = text.indexOf("    // Solara security backport:");
    const end = text.indexOf("\n\n    if ((token.type", start);
    assert.ok(start > 0 && end > start);
    writeFileSync(parser, text.slice(0, start) + "    const analysis = analyzeRepeatedExtglob(body, opts);" + text.slice(end));
  }, literalTest],
  ["star-quantifier-unprotected", () => edit(parser, "(token.type === 'plus' || token.type === 'star') && analysis.risky", "token.type === 'plus' && analysis.risky"), literalTest],
  ["recursion-opt-out-bypasses-guard", () => edit(parser, "const analysis = body.includes('*')", "const analysis = opts.maxExtglobRecursion !== false && body.includes('*')"), literalTest],
  ["incomplete-literal-escaping", () => {
    const line = readFileSync(parser, "utf8").split("\n").find(line => line.includes("? { risky: true, safeOutput: literal.replace"));
    assert.ok(line);
    edit(parser, line, "      ? { risky: true, safeOutput: utils.escapeRegex(literal) }");
  }, literalTest],
  ["all-matching-disabled", () => edit(matcher, "const matcher = (input, returnObject = false) => {", "const matcher = (input, returnObject = false) => { return false;"), "ordinary matching"],
  ["archive-integrity-corrupted", () => {
    const bytes = Buffer.from(originals.get(archive)); bytes[20] ^= 1; writeFileSync(archive, bytes);
  }, "vendored source, installed code and npm tarball"],
  ["minimatch-10-restored", () => downgrade(minimatch, "minimatch"), "minimatch bounds"],
  ["esbuild-018-restored", () => downgrade(esbuild, "esbuild"), "nested esbuild does not expose"],
  ["archive-excluded-from-deployment", () => writeFileSync(ignore, originals.get(ignore).toString("utf8") + "\nvendor/*.tgz\n"), "deployment input keeps PDF", "tests/deployment-inputs.test.ts"],
];
try {
  for (const [name, mutate, pattern, testFile = "tests/dependency-security.test.ts"] of mutations) {
    try {
      mutate();
      const result = run(name, [process.execPath, "--import", "tsx", "--test", `--test-name-pattern=${pattern}`, testFile]);
      assert.equal(result.status, 1, `${name}: mutant survived or test process failed unexpectedly`);
      assert.match(result.output, /code: 'ERR_ASSERTION'/, `${name}: assertion failure required`);
      assert.match(result.output, /not ok \d+ - (?:dependency security:|deployment input keeps PDF)/, `${name}: intended guard must fail`);
      assert.doesNotMatch(result.output, /SyntaxError|TransformError|ERR_MODULE_NOT_FOUND|ERR_PACKAGE_PATH_NOT_EXPORTED|ETIMEDOUT/, `${name}: harness failure is not a kill`);
      evidence.mutations.push({ name, testFile, pattern, result: "assertion-kill" });
      console.log(`${name}: assertion kill`);
    } finally { restore(); }
  }
  for (const [path, bytes] of originals) assert.equal(digest(readFileSync(path)), digest(bytes), `${path}: not restored`);
  evidence.restored = true;
  const clean = run("restored-security-suite", [process.execPath, "--import", "tsx", "--test", "tests/dependency-security.test.ts"]);
  assert.equal(clean.status, 0, clean.output);
  evidence.cleanRerun = true;
  assert.equal(execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim(), "", "tracked worktree must be restored");
  console.log(`${evidence.mutations.length}/${mutations.length} assertion kills; restored suite passed`);
} finally {
  restore();
  writeFileSync(join(folder, "result.json"), JSON.stringify(evidence, null, 2) + "\n");
}
