import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/** Use Git's own ignore matcher, including negations, rather than a second
 * approximation of .vercelignore. Only tracked source enters the fixture. */
export function deploymentInputFiles(): string[] {
  const list = (args: string[]) => execFileSync("git", ["ls-files", "-z", "--cached", ...args], { encoding: "utf8" }).split("\0").filter(Boolean);
  const ignored = new Set(list(["--ignored", "--exclude-from=.vercelignore"]));
  return list([]).filter(path => !ignored.has(path));
}

/** A throwaway source tree with the same excluded tests/tools as Vercel's
 * upload. Dependencies are reused, never copied into a deployment artifact. */
export function createDeploymentInputFixture() {
  const root = process.cwd();
  mkdirSync(resolve(".venv"), { recursive: true });
  const directory = mkdtempSync(resolve(".venv/deployment-inputs-"));
  const cleanup = () => rmSync(directory, { recursive: true, force: true });
  try {
    for (const path of deploymentInputFiles()) {
      const target = join(directory, path);
      mkdirSync(dirname(target), { recursive: true });
      cpSync(join(root, path), target);
    }
    symlinkSync(join(root, "node_modules"), join(directory, "node_modules"), "dir");
    return { directory, cleanup };
  } catch (error) { cleanup(); throw error; }
}
