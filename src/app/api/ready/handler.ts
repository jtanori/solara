import type { Readiness } from "@/lib/readiness";

const NO_STORE = { "Cache-Control": "no-store" };

export function createReadyHandler(readiness: () => Promise<Readiness>) {
  return async function GET() {
    try {
      const result = await readiness();
      return Response.json(result, {
        status: result.ok ? 200 : 503,
        headers: NO_STORE,
      });
    } catch {
      return Response.json(
        {
          ok: false,
          db: "error",
          schema: { missing: [], missingColumns: [], missingIndexes: [] },
          migrations: { pending: 0, unexpected: 0 },
          auth: "degraded",
        },
        { status: 503, headers: NO_STORE },
      );
    }
  };
}
