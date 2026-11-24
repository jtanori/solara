import { getReadiness } from "@/lib/readiness";
import { createReadyHandler } from "./handler";

export const dynamic = "force-dynamic";

export const GET = createReadyHandler(getReadiness);
