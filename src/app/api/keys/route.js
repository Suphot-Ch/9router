import { NextResponse } from "next/server";
import { getApiKeys, createApiKey, ApiKeyValidationError } from "@/lib/localDb";
import { getConsistentMachineId } from "@/shared/utils/machineId";

export const dynamic = "force-dynamic";

// GET /api/keys - List API keys
export async function GET() {
  try {
    const keys = await getApiKeys();
    return NextResponse.json({ keys });
  } catch (error) {
    console.log("Error fetching keys:", error);
    return NextResponse.json({ error: "Failed to fetch keys" }, { status: 500 });
  }
}

// POST /api/keys - Create new API key
export async function POST(request) {
  try {
    const body = await request.json();
    const { name } = body;

    if (!name) {
      return NextResponse.json({ error: "Name is required" }, { status: 400 });
    }

    // Always get machineId from server
    const machineId = await getConsistentMachineId();
    const apiKey = await createApiKey(name, machineId, {
      tokenLimit: body.tokenLimit,
      costLimit: body.costLimit,
      resetMode: body.resetMode,
      resetDay: body.resetDay,
    });

    return NextResponse.json({
      key: apiKey.key,
      name: apiKey.name,
      id: apiKey.id,
      machineId: apiKey.machineId,
      tokenLimit: apiKey.tokenLimit,
      costLimit: apiKey.costLimit,
      usedTokens: apiKey.usedTokens,
      usedCost: apiKey.usedCost,
      resetMode: apiKey.resetMode,
      resetDay: apiKey.resetDay,
      lastResetAt: apiKey.lastResetAt,
      createdAt: apiKey.createdAt,
    }, { status: 201 });
  } catch (error) {
    if (error instanceof ApiKeyValidationError || error?.status === 400) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    console.log("Error creating key:", error);
    return NextResponse.json({ error: "Failed to create key" }, { status: 500 });
  }
}
