import { handlePlaces } from "@/lib/places";

export async function GET(request: Request) {
  return handlePlaces(request);
}
