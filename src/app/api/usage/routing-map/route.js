import { NextResponse } from "next/server";
import { getRoutingMap, parseRoutingMapQuery, RoutingMapValidationError } from "@/lib/db/repos/routingMapRepo.js";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// /api/usage is dashboardGuard-protected by the existing middleware. Do not
// replace that guard with inference-key auth (which would expose other keys).
export async function GET(request) {
  try {
    const options = parseRoutingMapQuery(new URL(request.url).searchParams);
    return NextResponse.json(await getRoutingMap(options), { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    if (error instanceof RoutingMapValidationError) {
      return NextResponse.json({ error: error.message }, { status: 400, headers: { "Cache-Control": "private, no-store" } });
    }
    // Driver errors can contain SQL values and credentials: never log/echo them.
    return NextResponse.json({ error: "Failed to fetch routing map" }, { status: 500, headers: { "Cache-Control": "private, no-store" } });
  }
}
