import { getReadiness } from "@/lib/readiness";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };

export async function GET() {
  try {
    const readiness = await getReadiness();
    return Response.json(readiness, {
      status: readiness.ok ? 200 : 503,
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
}
