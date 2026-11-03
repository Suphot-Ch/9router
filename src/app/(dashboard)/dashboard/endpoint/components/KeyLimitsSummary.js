"use client";

// Consumption block on an API key row: tokens and USD spend against their caps,
// each with a thin progress bar and the percentage left. Colours follow the
// quota table (>70% left green, 30–70% yellow, <30% red); a cap of 0 renders as
// "Unlimited" with no bar.
import PropTypes from "prop-types";
import { cn } from "@/shared/utils/cn";
import {
  getKeyLimitStats,
  formatTokens,
  formatUsd,
  nextResetInfo,
  describeNextReset,
} from "@/shared/utils/keyLimits";

function LimitMeter({ label, usage, format }) {
  const unlimitedText = `${format(usage.used)} used · Unlimited`;
  const cappedText = `${format(usage.used)} / ${format(usage.limit)} · ${usage.remainingPercent}% left`;

  return (
    <div data-testid={`key-limit-${label.toLowerCase()}`}>
      <div className="flex items-center justify-between gap-2 text-xs">
        <span className="shrink-0 text-text-muted">{label}</span>
        <span className={cn("min-w-0 truncate text-right font-medium tabular-nums", usage.tone.text)}>
          {usage.unlimited ? unlimitedText : cappedText}
        </span>
      </div>
      {!usage.unlimited && (
        <div
          className={cn("mt-1 h-1.5 w-full overflow-hidden rounded-full", usage.tone.track)}
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={usage.remainingPercent}
          aria-label={`${label} budget remaining`}
        >
          <div
            className={cn("h-full rounded-full transition-all duration-300", usage.tone.bg)}
            style={{ width: `${usage.remainingPercent}%` }}
          />
        </div>
      )}
    </div>
  );
}

LimitMeter.propTypes = {
  label: PropTypes.string.isRequired,
  usage: PropTypes.object.isRequired,
  format: PropTypes.func.isRequired,
};

export default function KeyLimitsSummary({ apiKey, onEditLimits }) {
  const stats = getKeyLimitStats(apiKey);
  const reset = nextResetInfo({ resetMode: apiKey.resetMode, resetDay: apiKey.resetDay });
  const resetLabel = describeNextReset(reset);

  return (
    <div className="mt-2 flex flex-col gap-2" data-testid="key-limits">
      <div className="flex flex-wrap items-center gap-2">
        {stats.atLimit && (
          <span
            className="inline-flex items-center gap-1 rounded-full bg-red-500/10 px-2 py-0.5 text-[11px] font-semibold text-red-600 dark:text-red-400"
            data-testid="key-at-limit"
          >
            <span className="material-symbols-outlined text-[12px]">block</span>
            At limit
          </span>
        )}
        {(stats.atLimit || reset) && (
          <span className="min-w-0 truncate text-xs text-text-muted">
            {reset ? resetLabel : "No reset scheduled"}
          </span>
        )}
      </div>

      <LimitMeter label="Tokens" usage={stats.tokens} format={formatTokens} />
      <LimitMeter label="Cost" usage={stats.cost} format={(n) => formatUsd(n, { precise: true })} />

      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <button
          type="button"
          onClick={() => onEditLimits(apiKey)}
          aria-label={`Spending limits for ${apiKey.name}`}
          className="flex h-11 items-center gap-1 rounded-[10px] px-2 text-xs font-semibold text-primary transition-colors hover:bg-primary/10"
        >
          <span className="material-symbols-outlined text-[16px]">tune</span>
          Limits
        </button>
        {reset && !stats.atLimit && (
          <span className="min-w-0 truncate text-xs text-text-muted">{resetLabel}</span>
        )}
      </div>
    </div>
  );
}

KeyLimitsSummary.propTypes = {
  apiKey: PropTypes.shape({
    id: PropTypes.string.isRequired,
    name: PropTypes.string,
    tokenLimit: PropTypes.number,
    costLimit: PropTypes.number,
    usedTokens: PropTypes.number,
    usedCost: PropTypes.number,
    resetMode: PropTypes.oneOf(["none", "monthly", "weekly"]),
    resetDay: PropTypes.number,
  }).isRequired,
  onEditLimits: PropTypes.func.isRequired,
};
