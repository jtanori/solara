import { handleResetConfirm } from "@/lib/auth-service";
import { getLocale } from "@/lib/i18n-server";

export async function POST(request: Request) {
  return handleResetConfirm(request, await getLocale());
}
