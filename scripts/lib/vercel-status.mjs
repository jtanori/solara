import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

export function selectLatestStatus(statuses, context) {
  if (!Array.isArray(statuses)) return null;
  const matches = statuses.filter(status => status && status.context === context);
  if (!matches.length) return null;
  return matches
    .slice()
    .sort((a, b) => {
      const aTime = Date.parse(a.created_at ?? "");
      const bTime = Date.parse(b.created_at ?? "");
      return (Number.isNaN(aTime) ? 0 : aTime) - (Number.isNaN(bTime) ? 0 : bTime);
    })
    .at(-1);
}

function main() {
  const context = process.argv[2] ?? "Vercel";
  let payload;
  try {
    payload = JSON.parse(readFileSync(0, "utf8"));
  } catch {
    return;
  }
  const latest = selectLatestStatus(payload?.statuses, context);
  if (!latest) return;
  const state = typeof latest.state === "string" ? latest.state : "";
  const url = typeof latest.target_url === "string" ? latest.target_url : "";
  process.stdout.write(`${state}\t${url}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main();
}
