// Structure of the schedule editor: the parts the mobile layout depends on
// (44px targets, no horizontal overflow, internal scroll) plus the row/page
// wiring. Components are JSX modules, so these are source-level assertions in
// the same style as the other dashboard tests; behaviour is covered by
// connection-schedule-evaluation/-api/-service.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const modalSource = readFileSync(
  new URL("../../src/app/(dashboard)/dashboard/providers/[id]/ConnectionScheduleModal.js", import.meta.url),
  "utf8",
);
const rowSource = readFileSync(
  new URL("../../src/app/(dashboard)/dashboard/providers/[id]/ConnectionRow.js", import.meta.url),
  "utf8",
);
const pageSource = readFileSync(
  new URL("../../src/app/(dashboard)/dashboard/providers/[id]/page.js", import.meta.url),
  "utf8",
);

describe("connection schedule modal", () => {
  it("renders the seven weekdays from the shared week order with 44px targets", () => {
    expect(modalSource).toContain("CONNECTION_SCHEDULE_WEEK_ORDER.map");
    expect(modalSource).toContain("aria-pressed={selected}");
    expect(modalSource).toContain('className={cn(\n                    "flex h-11');
    expect(modalSource).toContain("grid-cols-4");
    expect(modalSource).toContain("sm:grid-cols-7");
  });

  it("exposes the enable switch, both time inputs and the timezone", () => {
    expect(modalSource).toContain('role="switch"');
    expect(modalSource).toContain("aria-checked={form.enabled}");
    expect(modalSource).toContain('label="Start"');
    expect(modalSource).toContain('label="End"');
    expect(modalSource).toContain('type="time"');
    expect(modalSource).toContain("Time zone");
    expect(modalSource).toContain("{form.timezone}");
  });

  it("shows the human summary and an inline error line", () => {
    expect(modalSource).toContain("formatScheduleSummary");
    expect(modalSource).toContain('role="alert"');
    expect(modalSource).toContain("setError(");
  });

  it("offers Save and a Remove action only for an existing schedule", () => {
    expect(modalSource).toContain("handleRemove");
    expect(modalSource).toContain("hasStoredSchedule");
    expect(modalSource).toMatch(/Remove\s*<\/Button>/);
    expect(modalSource).toMatch(/Save<\/Button>/);
    expect(modalSource).toContain('size="lg"');
  });

  it("keeps content inside a 390px viewport and scrolls internally", () => {
    // Single column stacks, truncation, no fixed pixel widths, min-w-0 guards on
    // flex children, and the shared Modal body handles max-h + overflow-y-auto.
    expect(modalSource).toContain("min-w-0");
    expect(modalSource).toContain("truncate");
    expect(modalSource).toContain("break-words");
    expect(modalSource).not.toMatch(/w-\[\d{3,}px\]/);
    expect(modalSource).toContain("<Modal");
  });

  it("talks to the per-connection schedule endpoint and shares validation", () => {
    expect(modalSource).toContain("/api/providers/${connection.id}/schedule");
    expect(modalSource).toContain('send("PUT"');
    expect(modalSource).toContain('send("DELETE")');
    expect(modalSource).toContain("validateConnectionSchedule");
    // The timezone comes from the schedule browser/server, never a hardcoded value.
    expect(modalSource).not.toContain("Asia/Bangkok");
  });
});

describe("connection row schedule action", () => {
  it("always renders a Schedule action next to Auto-ping", () => {
    expect(rowSource).toContain("event_upcoming");
    expect(rowSource).toContain("Schedule");
    expect(rowSource).toContain("schedule.onConfigure");
  });

  it("shows a compact badge when a schedule exists", () => {
    expect(rowSource).toContain("schedule?.badge");
    expect(rowSource).toContain("{schedule.badge}");
  });
});

describe("provider page wiring", () => {
  it("opens the schedule modal from the row and refreshes connections afterwards", () => {
    expect(pageSource).toContain("<ConnectionScheduleModal");
    expect(pageSource).toContain("onUpdated={fetchConnections}");
    expect(pageSource).toContain("setConnectionScheduleTarget(conn)");
    expect(pageSource).toContain("getScheduleBadgeLabel(conn.schedule)");
    expect(pageSource).toContain("formatScheduleSummary(conn.schedule)");
  });
});
