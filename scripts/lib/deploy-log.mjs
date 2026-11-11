// Renders the one-line deploy record appended to DEPLOY_LOG (docs/deploys.md).
// Kept as its own module so the table formatting is unit-testable without running a deploy.
//
// Usage: node scripts/lib/deploy-log.mjs '<json>'
// json: { env, sha, pr, migrations, result, rollback }

export const COLUMNS = ["env", "sha", "pr", "migrations", "result", "rollback"];

function cell(value) {
  const text = value === undefined || value === null || value === "" ? "—" : String(value);
  // Pipes would break the markdown table.
  return text.replace(/\|/g, "\\|").replace(/\n/g, " ");
}

export function renderDeployRecord(record) {
  const shortSha = String(record.sha ?? "").slice(0, 7) || "—";
  return [
    "|",
    cell(record.timestamp ?? ""),
    "|",
    cell(record.env),
    "|",
    "`" + shortSha + "`",
    "|",
    cell(record.pr),
    "|",
    cell(record.migrations),
    "|",
    cell(record.result),
    "|",
    cell(record.rollback),
    "|",
  ]
    .join(" ")
    .replace(/\|\s+\|/g, (match) => match); // keep alignment predictable
}

export function renderHeader() {
  return "| when | env | sha | pr | migrations | result | rollback |\n| --- | --- | --- | --- | --- | --- | --- |";
}

function main() {
  let record;
  try {
    record = JSON.parse(process.argv[2] ?? "{}");
  } catch {
    process.stderr.write("deploy-log: invalid JSON\n");
    process.exit(2);
  }
  process.stdout.write(renderDeployRecord(record) + "\n");
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop())) {
  main();
}
