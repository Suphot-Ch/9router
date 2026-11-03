"use client";

import { useState } from "react";
import PropTypes from "prop-types";
import { Button, Input, Modal } from "@/shared/components";
import { cn } from "@/shared/utils/cn";
import { getCurrentLocale } from "@/i18n/runtime";
import {
  CONNECTION_SCHEDULE_WEEK_ORDER,
  formatScheduleSummary,
  getLocalizedDayLabels,
  validateConnectionSchedule,
} from "@/shared/services/connectionSchedule";

const DEFAULT_DAYS = [1, 2, 3, 4, 5];
const DEFAULT_START = "09:00";
const DEFAULT_END = "18:00";

function getBrowserTimezone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

function toFormState(schedule) {
  return {
    enabled: schedule?.enabled !== false,
    days: Array.isArray(schedule?.days) && schedule.days.length > 0 ? [...schedule.days] : [...DEFAULT_DAYS],
    start: schedule?.start || DEFAULT_START,
    end: schedule?.end || DEFAULT_END,
    timezone: schedule?.timezone || getBrowserTimezone(),
  };
}

export default function ConnectionScheduleModal({ isOpen, onClose, connection, schedule = null, onUpdated }) {
  // Mounted only while open, so the form always starts from the stored schedule.
  const [form, setForm] = useState(() => toFormState(schedule));
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const dayLabels = getLocalizedDayLabels(getCurrentLocale());
  const hasStoredSchedule = Boolean(schedule);
  const summary = formatScheduleSummary(
    form,
    { dayLabels: Object.fromEntries(CONNECTION_SCHEDULE_WEEK_ORDER.map((day) => [day, dayLabels[day].short])) },
  );

  const update = (patch) => {
    setError("");
    setForm((prev) => ({ ...prev, ...patch }));
  };

  const toggleDay = (day) => {
    update({
      days: form.days.includes(day)
        ? form.days.filter((value) => value !== day)
        : [...form.days, day],
    });
  };

  const send = async (method, body) => {
    const response = await fetch(`/api/providers/${connection.id}/schedule`, {
      method,
      headers: { "Content-Type": "application/json" },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(data.error || "Failed to save the schedule");
    }
    return data;
  };

  const handleSave = async () => {
    const { schedule: candidate, error: validationError } = validateConnectionSchedule(form);
    if (validationError) {
      setError(validationError);
      return;
    }

    setBusy(true);
    try {
      const data = await send("PUT", candidate);
      onUpdated?.(data);
      onClose();
    } catch (saveError) {
      setError(saveError.message || "Failed to save the schedule");
    } finally {
      setBusy(false);
    }
  };

  const handleRemove = async () => {
    setBusy(true);
    try {
      const data = await send("DELETE");
      onUpdated?.(data);
      onClose();
    } catch (removeError) {
      setError(removeError.message || "Failed to remove the schedule");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title="Schedule"
      size="md"
      footer={
        <div className="flex w-full items-center justify-between gap-2">
          {hasStoredSchedule ? (
            <Button variant="ghost" size="lg" onClick={handleRemove} disabled={busy}>
              Remove
            </Button>
          ) : <span />}
          <div className="flex items-center gap-2">
            <Button variant="secondary" size="lg" onClick={onClose} disabled={busy}>Cancel</Button>
            <Button size="lg" onClick={handleSave} loading={busy} disabled={busy}>Save</Button>
          </div>
        </div>
      }
    >
      <div className="flex min-w-0 flex-col gap-4">
        <p className="text-sm text-text-muted">
          {connection?.name ? `${connection.name} is ` : "This account is "}
          active only during this weekly window and disabled outside it while the
          schedule is on.
        </p>

        <div className="flex items-center justify-between gap-3 rounded-[10px] bg-surface-2 px-3 py-1.5">
          <span className="text-sm font-medium text-text-main">Use schedule</span>
          {/* 44px hit area: the visible pill is 44x24, the button is 44x44. */}
          <button
            type="button"
            role="switch"
            aria-checked={form.enabled}
            aria-label="Use schedule"
            onClick={() => update({ enabled: !form.enabled })}
            className="flex h-11 w-11 shrink-0 items-center justify-center focus:outline-none focus:ring-2 focus:ring-brand-500/30 rounded-full"
          >
            <span
              className={cn(
                "relative inline-flex h-6 w-11 items-center rounded-full transition-colors duration-200",
                form.enabled ? "bg-brand-500" : "bg-surface-3",
              )}
            >
              <span
                className={cn(
                  "inline-block size-5 rounded-full bg-white shadow-sm transition-transform duration-200",
                  form.enabled ? "translate-x-5" : "translate-x-0.5",
                )}
              />
            </span>
          </button>
        </div>

        <div className="flex min-w-0 flex-col gap-1.5">
          <span className="text-sm font-medium text-text-main">Days</span>
          <div className="grid grid-cols-4 gap-1.5 sm:grid-cols-7">
            {CONNECTION_SCHEDULE_WEEK_ORDER.map((day) => {
              const selected = form.days.includes(day);
              return (
                <button
                  key={day}
                  type="button"
                  aria-pressed={selected}
                  aria-label={dayLabels[day].long}
                  onClick={() => toggleDay(day)}
                  className={cn(
                    "flex h-11 min-w-0 items-center justify-center rounded-[10px] text-sm font-medium transition-colors",
                    selected
                      ? "bg-brand-500 text-white"
                      : "bg-surface-2 text-text-muted hover:text-text-main",
                  )}
                >
                  <span className="truncate px-1">{dayLabels[day].short}</span>
                </button>
              );
            })}
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <Input
            label="Start"
            type="time"
            value={form.start}
            onChange={(e) => update({ start: e.target.value })}
            inputClassName="ring-1 ring-black/10 dark:ring-white/15 py-3"
          />
          <Input
            label="End"
            type="time"
            value={form.end}
            onChange={(e) => update({ end: e.target.value })}
            inputClassName="ring-1 ring-black/10 dark:ring-white/15 py-3"
          />
        </div>

        <div className="flex min-w-0 flex-col gap-1 rounded-[10px] bg-surface-2 px-3 py-2.5">
          <span className="text-xs font-medium uppercase tracking-wide text-text-muted">Time zone</span>
          <span className="truncate text-sm font-medium text-text-main" title={form.timezone}>
            {form.timezone}
          </span>
          <span className="text-xs text-text-muted">
            {!form.enabled
              ? "Off — the account stays under manual control."
              : summary
                ? `Active ${summary}`
                : "No window yet — pick at least one day."}
          </span>
        </div>

        <p className="text-xs text-text-muted">
          An end time at or before the start wraps past midnight into the next day.
        </p>

        {error && (
          <p role="alert" className="flex items-start gap-1 text-xs text-red-500">
            <span className="material-symbols-outlined text-[14px] leading-tight">error</span>
            <span className="min-w-0 break-words">{error}</span>
          </p>
        )}
      </div>
    </Modal>
  );
}

ConnectionScheduleModal.propTypes = {
  isOpen: PropTypes.bool.isRequired,
  onClose: PropTypes.func.isRequired,
  connection: PropTypes.shape({
    id: PropTypes.string.isRequired,
    name: PropTypes.string,
  }).isRequired,
  schedule: PropTypes.object,
  onUpdated: PropTypes.func,
};
