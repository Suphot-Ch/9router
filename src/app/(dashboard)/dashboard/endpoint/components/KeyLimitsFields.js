"use client";

// Shared form for a key's spending limits, used by both the "Limits" sheet and
// the create-key modal so the two never drift apart.
//
// Every field is optional: blank or 0 means unlimited. Token counts accept
// digits only, the USD limit accepts one decimal point, and the reset selector
// swaps between monthly days (1..31) and weekdays (Sunday..Saturday).
import PropTypes from "prop-types";
import { Input } from "@/shared/components";
import {
  RESET_MODE_OPTIONS,
  resetDayOptions,
  effectiveResetDay,
  nextResetInfo,
  describeNextReset,
  digitsOnly,
  decimalOnly,
} from "@/shared/utils/keyLimits";

export const EMPTY_LIMITS = Object.freeze({
  tokenLimit: "",
  costLimit: "",
  resetMode: "none",
  resetDay: "",
});

const SELECT =
  "h-11 w-full rounded-[10px] border border-transparent bg-surface-2 px-3 text-sm text-text-main " +
  "focus:outline-none focus:ring-2 focus:ring-brand-500/30 focus:border-brand-500/40 " +
  "disabled:opacity-50 disabled:cursor-not-allowed";

export default function KeyLimitsFields({ values, onChange, idPrefix = "key-limits", disabled = false }) {
  const set = (patch) => onChange({ ...values, ...patch });
  const days = resetDayOptions(values.resetMode);
  // The select always shows a valid day, so the hint must use the same value.
  const dayValue = effectiveResetDay(values.resetMode, values.resetDay);
  const reset = nextResetInfo({ resetMode: values.resetMode, resetDay: dayValue });
  const resetLabel = describeNextReset(reset);

  const onModeChange = (resetMode) => {
    // Day must stay valid for the new mode: monthly 1..31, weekly 0..6.
    const first = resetDayOptions(resetMode)[0];
    set({ resetMode, resetDay: first ? String(first.value) : "" });
  };

  return (
    <div className="flex flex-col gap-4">
      <Input
        id={`${idPrefix}-token`}
        label="Token limit"
        aria-label="Token limit"
        inputMode="numeric"
        autoComplete="off"
        placeholder="Unlimited"
        value={values.tokenLimit}
        disabled={disabled}
        onChange={(e) => set({ tokenLimit: digitsOnly(e.target.value) })}
        hint="Blank or 0 = unlimited tokens."
      />

      <Input
        id={`${idPrefix}-cost`}
        label="USD cost limit"
        aria-label="USD cost limit"
        inputMode="decimal"
        autoComplete="off"
        placeholder="Unlimited"
        value={values.costLimit}
        disabled={disabled}
        onChange={(e) => set({ costLimit: decimalOnly(e.target.value) })}
        hint="Blank or 0 = unlimited spend. Two decimal places."
      />

      <div className="flex flex-col gap-1.5">
        <label htmlFor={`${idPrefix}-reset-mode`} className="text-sm font-medium text-text-main">
          Reset usage
        </label>
        <select
          id={`${idPrefix}-reset-mode`}
          className={SELECT}
          value={values.resetMode}
          disabled={disabled}
          onChange={(e) => onModeChange(e.target.value)}
        >
          {RESET_MODE_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </div>

      {days.length > 0 && (
        <div className="flex flex-col gap-1.5">
          <label htmlFor={`${idPrefix}-reset-day`} className="text-sm font-medium text-text-main">
            {values.resetMode === "monthly" ? "Reset day of month" : "Reset weekday"}
          </label>
          <select
            id={`${idPrefix}-reset-day`}
            className={SELECT}
            value={String(dayValue ?? days[0].value)}
            disabled={disabled}
            onChange={(e) => set({ resetDay: e.target.value })}
          >
            {days.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
          {resetLabel && <p className="text-xs text-text-muted">{resetLabel}</p>}
        </div>
      )}
    </div>
  );
}

KeyLimitsFields.propTypes = {
  values: PropTypes.shape({
    tokenLimit: PropTypes.oneOfType([PropTypes.string, PropTypes.number]),
    costLimit: PropTypes.oneOfType([PropTypes.string, PropTypes.number]),
    resetMode: PropTypes.oneOf(["none", "monthly", "weekly"]),
    resetDay: PropTypes.oneOfType([PropTypes.string, PropTypes.number]),
  }).isRequired,
  onChange: PropTypes.func.isRequired,
  idPrefix: PropTypes.string,
  disabled: PropTypes.bool,
};
