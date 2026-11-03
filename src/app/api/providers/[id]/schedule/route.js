import { NextResponse } from "next/server";
import { getProviderConnectionById, updateProviderConnection } from "@/lib/localDb";
import {
  evaluateConnectionSchedule,
  validateConnectionSchedule,
} from "@/shared/services/connectionSchedule";

export const dynamic = "force-dynamic";

// GET / PUT / DELETE share one response shape so the UI can swap the row state
// from any of them: { schedule, active, nextChangeAt }
//   schedule         → the stored window (also when parked, so the UI can show
//                      "Auto off" and re-enable it with the same days/times)
//   active === null  → no window is governing this connection right now
function scheduleResponse(connection) {
  // Validate regardless of `enabled`: a parked schedule is still returned, it just
  // does not evaluate to an active window.
  const { schedule } = validateConnectionSchedule(connection?.schedule);
  const evaluation = schedule && schedule.enabled === true
    ? evaluateConnectionSchedule(schedule)
    : null;

  return {
    schedule: schedule || null,
    active: evaluation ? evaluation.active : null,
    nextChangeAt: evaluation ? evaluation.nextChangeAt : null,
  };
}

// The scheduler stops itself when the last schedule disappears, so a save has to
// wake it up again for future transitions. Best-effort: never fail the request.
async function ensureSchedulerRunning(enabled) {
  if (!enabled) return;
  try {
    const { startConnectionSchedules } = await import("@/shared/services/connectionSchedules");
    startConnectionSchedules();
  } catch { /* scheduler restarts with the app */ }
}

// GET /api/providers/[id]/schedule
export async function GET(request, { params }) {
  try {
    const { id } = await params;
    const connection = await getProviderConnectionById(id);
    if (!connection) {
      return NextResponse.json({ error: "Connection not found" }, { status: 404 });
    }
    return NextResponse.json(scheduleResponse(connection));
  } catch (error) {
    console.log("Error fetching connection schedule:", error);
    return NextResponse.json({ error: "Failed to fetch connection schedule" }, { status: 500 });
  }
}

// PUT /api/providers/[id]/schedule — body: the schedule object
// ({ enabled, days, start, end, timezone }). Saves, applies immediately, and
// returns the resulting state.
export async function PUT(request, { params }) {
  try {
    const { id } = await params;
    const existing = await getProviderConnectionById(id);
    if (!existing) {
      return NextResponse.json({ error: "Connection not found" }, { status: 404 });
    }

    const body = await request.json().catch(() => null);
    const payload = body && typeof body === "object" && !Array.isArray(body) && body.schedule !== undefined
      ? body.schedule
      : body;

    const { schedule, error } = validateConnectionSchedule(payload);
    if (error) {
      return NextResponse.json({ error }, { status: 400 });
    }

    const evaluation = evaluateConnectionSchedule(schedule);
    const patch = { schedule: { ...schedule } };

    // Apply on save so the account flips immediately instead of waiting a tick.
    if (evaluation && existing.isActive !== evaluation.active) {
      patch.isActive = evaluation.active;
      patch.schedule.lastAppliedState = evaluation.active ? "active" : "disabled";
      patch.schedule.lastAppliedAt = new Date().toISOString();
    }

    const updated = await updateProviderConnection(id, patch);
    await ensureSchedulerRunning(schedule.enabled);

    return NextResponse.json(scheduleResponse(updated));
  } catch (error) {
    console.log("Error saving connection schedule:", error);
    return NextResponse.json({ error: "Failed to save connection schedule" }, { status: 500 });
  }
}

// DELETE /api/providers/[id]/schedule — drop the schedule and leave isActive as
// it is, so the user gets manual control back exactly where the window left it.
export async function DELETE(request, { params }) {
  try {
    const { id } = await params;
    const existing = await getProviderConnectionById(id);
    if (!existing) {
      return NextResponse.json({ error: "Connection not found" }, { status: 404 });
    }

    await updateProviderConnection(id, { schedule: null });

    return NextResponse.json({ schedule: null, active: null, nextChangeAt: null });
  } catch (error) {
    console.log("Error removing connection schedule:", error);
    return NextResponse.json({ error: "Failed to remove connection schedule" }, { status: 500 });
  }
}
