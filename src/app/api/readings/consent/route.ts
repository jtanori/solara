import { handleConsent } from "@/readings/http";

export async function GET(request: Request) { return handleConsent(request); }
export async function PUT(request: Request) { return handleConsent(request); }
export async function DELETE(request: Request) { return handleConsent(request); }
