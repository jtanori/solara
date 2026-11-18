import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { gunzipSync } from "node:zlib";
import type * as Esbuild from "esbuild";
import provenance from "../vendor/picomatch-provenance.json";

const require = createRequire(import.meta.url);
const backport = provenance.packages[0];
const sha256 = (input: Buffer | string) => createHash("sha256").update(input).digest("hex");
const installedPicomatch = require.resolve("picomatch");
const fromKit = createRequire(require.resolve("drizzle-kit"));
const fromLoader = createRequire(fromKit.resolve("@esbuild-kit/esm-loader"));
const fromCore = createRequire(fromLoader.resolve("@esbuild-kit/core-utils"));
const fromEstree = createRequire(require.resolve("@typescript-eslint/typescript-estree"));

interface Picomatch {
  (pattern: string, options?: Record<string, unknown>): (input: string) => boolean;
  makeRe(pattern: string, options?: Record<string, unknown>): RegExp;
  parse(pattern: string, options?: Record<string, unknown>): unknown;
  compileRe(state: unknown, options?: Record<string, unknown>): RegExp;
}

function scratch() {
  mkdirSync(resolve(".venv"), { recursive: true });
  const directory = mkdtempSync(resolve(".venv/dependency-security-"));
  return { directory, cleanup: () => rmSync(directory, { recursive: true, force: true }) };
}

/** Isolate hostile regex/optimizer work: a blocked event loop cannot time itself out. */
function boundedNode(script: string) {
  const result = spawnSync(process.execPath, ["--max-old-space-size=64", "--eval", script], {
    encoding: "utf8", timeout: 5_000, killSignal: "SIGKILL", maxBuffer: 256 * 1024,
  });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, `${result.signal ?? ""}\n${result.stdout}\n${result.stderr}`);
}

test("dependency security: lockfile keeps patched tool dependencies dev-only with no registry Picomatch", () => {
  const manifest = JSON.parse(readFileSync("package.json", "utf8"));
  const lock = JSON.parse(readFileSync("package-lock.json", "utf8")) as {
    packages: Record<string, { name?: string; version?: string; resolved?: string; integrity?: string; dev?: boolean }>;
  };
  assert.equal(manifest.overrides.picomatch, "$picomatch");
  assert.equal(manifest.devDependencies.picomatch, `file:${backport.archive.path}`);
  let picomatchCount = 0;
  for (const [path, entry] of Object.entries(lock.packages)) {
    if (path.endsWith("/picomatch") || entry.name?.startsWith("@solara/picomatch")) {
      picomatchCount++;
      assert.equal(entry.name, backport.name, `unpatched matcher at ${path}`);
      assert.equal(entry.version, backport.version, path);
      assert.equal(entry.resolved, `file:${backport.archive.path}`, path);
      assert.equal(entry.integrity, backport.archive.integrity, path);
      assert.equal(entry.dev, true, path);
    }
    if (path.endsWith("/esbuild")) {
      const [major, minor] = entry.version!.split(".").map(Number);
      assert.ok(major > 0 || minor >= 25, `vulnerable esbuild at ${path}`);
      assert.equal(entry.dev, true, path);
    }
    if (path.endsWith("/minimatch")) {
      const [major, minor, patch] = entry.version!.split(".").map(Number);
      assert.ok(major < 7 || major > 11 || (major === 11 && (minor > 0 || patch >= 1)), `vulnerable minimatch at ${path}`);
    }
  }
  assert.equal(picomatchCount, 1, "all callers must share the checked backport");
});

test("dependency security: vendored source, installed code and npm tarball have identical reviewed bytes", () => {
  const sourceRoot = resolve(backport.path);
  const installedRoot = dirname(installedPicomatch);
  for (const [file, hashes] of Object.entries(backport.files)) {
    const content = readFileSync(join(sourceRoot, file));
    assert.equal(sha256(content), hashes.vendored, `${file} differs from the reviewed backport`);
    assert.ok(readFileSync(join(installedRoot, file)).equals(content), `installed ${file} is stale`);
    if (file !== "lib/parse.js") assert.equal(hashes.vendored, hashes.upstream, `unexpected upstream edit: ${file}`);
  }
  const patched = readFileSync(join(sourceRoot, "lib/parse.js"), "utf8");
  const start = patched.indexOf("    // Solara security backport:");
  const end = patched.indexOf("\n\n    if ((token.type", start);
  assert.ok(start > 0 && end > start);
  const upstream = patched.slice(0, start) + "    const analysis = analyzeRepeatedExtglob(body, opts);" + patched.slice(end);
  assert.equal(sha256(upstream), backport.files["lib/parse.js"].upstream, "the patch must be the only upstream source difference");
  const metadata = JSON.parse(readFileSync(join(sourceRoot, "package.json"), "utf8"));
  assert.equal(metadata.name, backport.name);
  assert.equal(metadata.version, backport.version);
  assert.equal(metadata.private, true);
  assert.equal(metadata.scripts, undefined, "the local package must not introduce install hooks");
  assert.equal(metadata.dependencies, undefined, "the backport must remain dependency-free");
  assert.deepEqual(readFileSync(join(installedRoot, "package.json")), readFileSync(join(sourceRoot, "package.json")));

  const archive = readFileSync(backport.archive.path);
  assert.equal(`sha512-${createHash("sha512").update(archive).digest("base64")}`, backport.archive.integrity);
  // npm's tarball contains these nine short regular-file names, no symlinks,
  // long-name/PAX records or directories. Read only; never extract arbitrary paths.
  const tar = gunzipSync(archive, { maxOutputLength: 1024 * 1024 });
  const expected = new Set([...Object.keys(backport.files), "package.json"]);
  for (let offset = 0; offset < tar.length; ) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every(byte => byte === 0)) break;
    assert.equal(header.length, 512);
    assert.equal(String.fromCharCode(header[156]), "0");
    const name = header.subarray(0, 100).toString("utf8").split("\0", 1)[0];
    assert.ok(name.startsWith("package/"));
    const file = name.slice("package/".length);
    assert.ok(expected.delete(file), `unexpected or duplicate archive member: ${name}`);
    const size = Number.parseInt(header.subarray(124, 136).toString("ascii").split("\0", 1)[0].trim(), 8);
    assert.ok(Number.isSafeInteger(size) && size > 0 && size < 128 * 1024);
    assert.deepEqual(tar.subarray(offset + 512, offset + 512 + size), readFileSync(join(sourceRoot, file)), `archive ${file} is stale`);
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  assert.equal(expected.size, 0, `missing archive members: ${[...expected]}`);
});

for (const consumer of ["micromatch", "tinyglobby", "fdir"]) {
  test(`dependency security: ${consumer} uses the patched matcher and restricts repeated extglobs`, () => {
    const fromConsumer = createRequire(require.resolve(consumer));
    assert.equal(fromConsumer.resolve("picomatch"), installedPicomatch);
    const pm = fromConsumer("picomatch") as Picomatch;
    const cases = [
      ["+(*)", "aaa"], ["+(*a)", "aaa"], ["*(*a)", "aaa"], ["+(a*)", "aaa"],
      ["+(a*b)", "abab"], ["+(*a|b)", "aaab"], ["+(@(*a))", "aaa"],
      ["src/+(*a).ts", "src/aaa.ts"], ["+([*])", "***"], ["+(\"*\")", "***"], ["+(\\*)", "***"],
      ["+([ab]+)", "aaa"], ["*([ab]+)", "aaa"], ["+((a+))", "aaa"], ["+(+(a))", "aaa"],
      ["+(a?(b))", "aaa"], ["+(a?)", "aaaa"], ["+([ab])", "aba"], ["+(a|aa)", "aaa"],
      ["+(foo|foobar)", "foofoobar"], ["+(a|A)", "aA"], ["+([a\\+]b)", "ab"],
      ["+(a|b|c|d|e|f|g|h|i|j|k|l|m|n|o|p|q)", "abc"],
    ];
    for (const options of [{}, { capture: true }, { bash: true }, { windows: true }, { regex: true }, { regex: false }, { nocase: true }, { flags: "i" }, { maxExtglobRecursion: false }]) {
      for (const [pattern, formerlyMatched] of cases) {
        assert.equal(pm(pattern, options)(formerlyMatched), false, `${consumer}: ${pattern} must not compile a wildcard repetition`);
        // Avoid picomatch's input===pattern shortcut: the compiled regex itself
        // must preserve the literal fallback, including capture/low-level APIs.
        assert.equal(pm.makeRe(pattern, options).test(pattern), true, pattern);
        assert.equal(pm.makeRe(pattern, options).test(formerlyMatched), false, pattern);
        assert.equal(pm.compileRe(pm.parse(pattern, options), options).test(formerlyMatched), false, pattern);
      }
    }
  });
}

test("dependency security: repeated wildcard attacks complete within an external CPU and memory bound", () => {
  boundedNode(`
    const assert = require('node:assert/strict');
    const pm = require(${JSON.stringify(installedPicomatch)});
    const patterns = ['+(*)', '+(*a)', '*(*a)', '+(*)b', '+(a*)b', '+(@(*a))', '+(@(*)a)', '+(*a|b)', '+(*a|b)b', '*(*a|b)b', '+(a*a*a*a*a*)', '*(a*|b)z', '+(a*|b)z', '+([*a)', '+([*a])', '+(W*, *)z', '*(W*, *)z'];
    const inputs = ['a'.repeat(60000) + '/', '[a]'.repeat(10000) + '!', 'W, '.repeat(10000) + '!'];
    for (const options of [{}, { dot: true }, { windows: true }, { bash: true }, { capture: true }, { nocase: true }, { nobracket: true }, { unescape: true }, { maxExtglobRecursion: false }]) {
      for (const pattern of patterns) for (const input of inputs) {
        assert.equal(pm(pattern, options)(input), false, pattern);
        assert.equal(pm.makeRe(pattern, options).test(input), false, pattern);
      }
    }
  `);
});

test("dependency security: star-free repeated extglob attacks are bounded through every installed API", () => {
  const callers = ["micromatch", "tinyglobby", "fdir"].map(name => createRequire(require.resolve(name)).resolve("picomatch"));
  boundedNode(`
    const assert = require('node:assert/strict');
    const patterns = ['+([ab]+)', '*([ab]+)', '+((a+))', '+(+(a))', '+(a?(b))', '+(a?)', '+([ab]|a)', '+(a|aa)', '+(foo|foobar)', '+(a|A)', '+(@(a|aa))', '+([[:alpha:]]+)'];
    const inputs = ['a'.repeat(35) + '!', 'a'.repeat(60000) + '!', 'foo'.repeat(20000) + '!', 'A'.repeat(60000) + '!'];
    for (const entry of ${JSON.stringify(callers)}) {
      const pm = require(entry);
      for (const options of [{}, { capture: true }, { bash: true }, { windows: true }, { dot: true }, { nocase: true }, { flags: 'i' }, { regex: false }, { regex: true }, { unescape: true }, { nobracket: true }, { maxExtglobRecursion: false }, { maxExtglobRecursion: 1000 }]) {
        for (const pattern of patterns) {
          const match = pm(pattern, options), re = pm.makeRe(pattern, options), compiled = pm.compileRe(pm.parse(pattern, options), options);
          assert.equal(re.test(pattern), true, pattern);
          assert.equal(compiled.test(pattern), true, pattern);
          for (const input of inputs) for (const test of [match, value => re.test(value), value => compiled.test(value)]) assert.equal(test(input), false, pattern);
        }
        // Positive grammar: deterministic literal repeats still work; rejecting
        // every pattern is not an acceptable security fix.
        assert.equal(pm('+(foo|bar)', options)('foobarfoo'), true);
        assert.equal(pm('*(foo|bar)', options)('foobarfoo'), true);
        assert.equal(pm.makeRe('+(a)', options).test('a'.repeat(60000) + '!'), false);
      }
    }
  `);
});

test("dependency security: ordinary matching, finite extglobs and real filesystem callers stay functional", async () => {
  const pm = require("picomatch") as Picomatch;
  const cases: [string, string, boolean, Record<string, unknown>?][] = [
    ["**/*.{ts,tsx}", "src/lib/log.ts", true], ["**/*.{ts,tsx}", "README.md", false],
    ["**/*.ts", "src/.hidden.ts", false], ["**/*.ts", "src/.hidden.ts", true, { dot: true }],
    ["*.ts", "INDEX.TS", true, { nocase: true }], ["src/[ab]*.ts", "src/alpha.ts", true],
    ["src/[ab]*.ts", "src/zeta.ts", false], ["+(foo|bar).ts", "foobar.ts", true],
    ["+(foo|bar).ts", "foobaz.ts", false], ["*.!(json)", "index.ts", true],
    ["*.!(json)", "index.json", false], ["!(*.test).ts", "main.ts", true],
    ["!(*.test).ts", "main.test.ts", false], ["@(foo|bar).js", "foo.js", true],
    ["file?.ts", "file1.ts", true], ["file?.ts", "file12.ts", false],
  ];
  for (const [pattern, input, expected, options] of cases) assert.equal(pm(pattern, options)(input), expected, `${pattern}: ${input}`);

  const fixture = scratch();
  try {
    for (const file of ["src/main.ts", "src/view.tsx", "src/main.test.ts", "src/nested/other.ts", "src/.hidden.ts", "README.md"]) {
      mkdirSync(dirname(join(fixture.directory, file)), { recursive: true });
      writeFileSync(join(fixture.directory, file), "export {};\n");
    }
    const options = { cwd: fixture.directory, ignore: ["**/*.test.ts"], dot: false };
    const expected = ["src/main.ts", "src/nested/other.ts", "src/view.tsx"];
    const fastGlob = require("fast-glob") as { sync(pattern: string, options: unknown): string[] };
    const tinyGlob = require("tinyglobby") as { glob(pattern: string, options: unknown): Promise<string[]>; globSync(pattern: string, options: unknown): string[] };
    assert.deepEqual(fastGlob.sync("src/**/*.{ts,tsx}", options).sort(), expected);
    assert.deepEqual(tinyGlob.globSync("src/**/*.{ts,tsx}", options).sort(), expected);
    assert.deepEqual((await tinyGlob.glob("src/**/*.{ts,tsx}", options)).sort(), expected);
  } finally { fixture.cleanup(); }
});

test("dependency security: minimatch bounds double-star parent expansion without breaking normal matches", () => {
  boundedNode(`
    const assert = require('node:assert/strict');
    const { Minimatch } = require(${JSON.stringify(fromEstree.resolve("minimatch"))});
    assert.equal(new Minimatch('src/**/*.ts', { optimizationLevel: 2 }).match('src/lib/log.ts'), true);
    assert.throws(() => new Minimatch('a/**/../'.repeat(18) + 'x', { optimizationLevel: 2 }), {
      name: 'RangeError', message: "optimizationLevel 2: too many patterns from '**/..'",
    });
  `);
});

test("dependency security: the legacy Drizzle loader works with patched synchronous and asynchronous transforms", async () => {
  const core = fromLoader("@esbuild-kit/core-utils") as {
    transformSync(source: string, filename: string): { code: string; map: unknown };
    transform(source: string, filename: string): Promise<{ code: string; map: unknown }>;
  };
  const source = "const answer: number = 42; export default answer;";
  const filename = resolve(".venv/loader-fixture.ts");
  for (const result of [core.transformSync(source, filename), await core.transform(source, filename)]) {
    assert.match(result.code, /42/);
    assert.doesNotMatch(result.code, /: number/);
    assert.ok(result.map);
  }
});

test("dependency security: nested esbuild does not expose served source to foreign-origin browser reads", async () => {
  const esbuild = fromCore("esbuild") as typeof Esbuild;
  const fixture = scratch();
  let context: Esbuild.BuildContext | undefined;
  try {
    const source = "export const privateBuildFixture = 42;\n";
    writeFileSync(join(fixture.directory, "source.js"), source);
    context = await esbuild.context({ entryPoints: [], outdir: join(fixture.directory, "compiled") });
    const server = await context.serve({ host: "127.0.0.1", port: 0, servedir: fixture.directory });
    const origin = "https://attacker.invalid";
    const response = await fetch(`http://127.0.0.1:${server.port}/source.js`, { headers: { Origin: origin }, signal: AbortSignal.timeout(3000) });
    const body = await response.text();
    assert.ok(response.status === 200 || response.status === 403, `unexpected serving failure: ${response.status}`);
    if (response.status === 200) assert.equal(body, source, "prove this request reached the real served fixture");
    else assert.ok(!body.includes("privateBuildFixture"));
    assert.notEqual(response.headers.get("access-control-allow-origin"), "*", "wildcard CORS leaks build source");
    assert.notEqual(response.headers.get("access-control-allow-origin"), origin, "foreign origin must not be reflected");
  } finally { await context?.dispose(); fixture.cleanup(); }
});
