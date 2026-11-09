import { NextResponse } from "next/server";

export async function GET() {
  const response = new NextResponse(
    "<!doctype html><meta charset=\"utf-8\"><title>Verification link updated</title><p>This email link format is no longer used. Request a new claim link from <a href=\"/verify-email\">the verification page</a>.</p>",
    {
      status: 200,
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
        "Referrer-Policy": "no-referrer",
      },
    },
  );
  return response;
}
