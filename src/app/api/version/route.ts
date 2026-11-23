import { createVersionHandler } from "./handler";

// Identity must never be cached: a cached answer is confidently wrong after a
// rollback, which is exactly when someone is asking.
export const dynamic = "force-dynamic";

export const GET = createVersionHandler();
