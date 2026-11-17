import "dotenv/config";
import { setTimeout as delay } from "node:timers/promises";
import { pool, coordinationPool } from "../src/db";
import { PaidReadingStore } from "../src/readings/paid-store";
import { paidGenerationConfig, paidGenerationEnabled } from "../src/readings/paid-policy";
import { workOnePaidReading } from "../src/readings/paid-worker";
import { log } from "../src/lib/log";

/** Dedicated supervised process, NOT a Next request continuation or public route.
 * Binding/redundancy/monitoring of the hosted executor is a separate release gate.
 */
async function main() {
  const [mode, ...extra] = process.argv.slice(2);
  if (extra.length || !["--once", "--loop", "--disable", "--enable"].includes(mode)) throw new Error("Use --once, --loop, --disable or --enable");
  const store = new PaidReadingStore();
  if (mode === "--disable" || mode === "--enable") {
    if (mode === "--enable" && (!paidGenerationEnabled() || !paidGenerationConfig())) throw new Error("Paid configuration is not ready; shared control remains unchanged");
    await store.setEnabled(mode === "--enable");
    log.info("readings.paid_control_updated", { enabled: mode === "--enable" });
    return;
  }
  let stopping = false;
  const stop = () => { stopping = true; };
  process.once("SIGTERM", stop); process.once("SIGINT", stop);
  try {
    do {
      try { await workOnePaidReading({ store }); }
      catch { log.warn("readings.paid_worker_cycle_failed", { code: "paid_worker_unavailable" }); if (mode === "--once") throw new Error("paid_worker_unavailable"); }
      if (mode !== "--loop" || stopping) break;
      await delay(2_000);
    } while (!stopping);
  } finally { process.removeListener("SIGTERM", stop); process.removeListener("SIGINT", stop); }
}
main().catch(error => { log.error("readings.paid_worker_start_failed", { code: error instanceof Error && error.message.startsWith("Use ") ? "invalid_arguments" : "paid_unavailable" }); process.exitCode = 1; })
  .finally(async () => { await Promise.all([pool.end(), coordinationPool.end()]); });
