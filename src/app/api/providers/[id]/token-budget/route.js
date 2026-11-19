import { NextResponse } from "next/server";
import {
  getConnectionTokenBudget,
  updateConnectionTokenBudget,
  deleteConnectionTokenBudget,
  ConnectionTokenBudgetValidationError,
} from "@/lib/db/repos/connectionTokenBudgetsRepo.js";

export const dynamic = "force-dynamic";

const response = (budget) => budget === null
  ? NextResponse.json({ error: "Connection not found" }, { status: 404 })
  : NextResponse.json({ budget });

function failure(error) {
  if (error instanceof ConnectionTokenBudgetValidationError) {
    return NextResponse.json({ error: error.message }, { status: 400 });
  }
  // Never serialize database errors or whole connection rows (credentials).
  return NextResponse.json({ error: "Failed to process connection token budget" }, { status: 500 });
}

// Protected by the existing /api/providers authentication prefix.
export async function GET(request, { params }) {
  try {
    const { id } = await params;
    return response(await getConnectionTokenBudget(id));
  } catch (error) { return failure(error); }
}

export async function PUT(request, { params }) {
  try {
    const { id } = await params;
    let input;
    try { input = await request.json(); }
    catch { throw new ConnectionTokenBudgetValidationError("Invalid JSON body"); }
    if (input && typeof input === "object" && !Array.isArray(input) && Object.hasOwn(input, "budget")) {
      if (Object.keys(input).length !== 1) throw new ConnectionTokenBudgetValidationError("Unknown budget envelope field");
      input = input.budget;
    }
    return response(await updateConnectionTokenBudget(id, input));
  } catch (error) { return failure(error); }
}

export async function DELETE(request, { params }) {
  try {
    const { id } = await params;
    return response(await deleteConnectionTokenBudget(id));
  } catch (error) { return failure(error); }
}
