import { after } from "next/server";
import { handleClaimRequest } from "@/lib/auth-service";
import { getLocale } from "@/lib/i18n-server";
import { createMailTransport } from "@/lib/mail";

export async function POST(request: Request) {
  const outcome = await handleClaimRequest(request, {
    locale: await getLocale(),
    mail: () => createMailTransport(),
  });
  for (const task of outcome.tasks) after(task);
  return outcome.response;
}
