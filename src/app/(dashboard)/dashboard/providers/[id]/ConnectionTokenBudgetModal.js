"use client";

import { useEffect, useRef, useState } from "react";
import PropTypes from "prop-types";
import { Button, Input, Modal } from "@/shared/components";
import {
  effectiveResetDay,
  formatTokens,
  getLimitUsage,
  RESET_MODE_OPTIONS,
  resetDayOptions,
} from "@/shared/utils/keyLimits";

const SELECT = "h-11 min-w-0 w-full rounded-[10px] border border-transparent bg-surface-2 px-3 text-sm text-text-main focus:outline-none focus:ring-2 focus:ring-brand-500/30 disabled:opacity-50";

async function requestBudget(id, method = "GET", body) {
  const response = await fetch(`/api/providers/${encodeURIComponent(id)}/token-budget`, {
    method,
    cache: "no-store",
    ...(body ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || "Failed to update token limits");
  if (!Object.hasOwn(data, "budget")) throw new Error("Token budget response is incomplete. Please retry.");
  return data.budget;
}

function toForm(budget) {
  return {
    tokenLimit: String(budget?.tokenLimit ?? 0),
    resetMode: budget?.resetMode || "none",
    resetDay: budget?.resetDay == null ? "" : String(budget.resetDay),
  };
}

export default function ConnectionTokenBudgetModal({ isOpen, onClose, connection, onUpdated }) {
  const [budget, setBudget] = useState(null);
  const [form, setForm] = useState(() => toForm(null));
  const [loading, setLoading] = useState(true);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirmAction, setConfirmAction] = useState(null);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const updatedRef = useRef(onUpdated);
  updatedRef.current = onUpdated;

  useEffect(() => {
    if (!isOpen) return;
    let cancelled = false;
    setLoading(true);
    setLoaded(false);
    setError("");
    setBudget(null);
    setConfirmAction(null);
    requestBudget(connection.id)
      .then((loaded) => {
        if (cancelled) return;
        setBudget(loaded);
        setLoaded(true);
        setForm(toForm(loaded));
        updatedRef.current?.(loaded);
      })
      .catch((loadError) => { if (!cancelled) setError(loadError.message); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [isOpen, connection.id, loadAttempt]);

  const update = (patch) => { setForm((previous) => ({ ...previous, ...patch })); setError(""); setConfirmAction(null); };
  const usage = getLimitUsage(budget?.usedTokens, budget?.tokenLimit);
  const days = resetDayOptions(form.resetMode);
  const dayValue = effectiveResetDay(form.resetMode, form.resetDay);
  const blocked = loading || busy || !loaded;

  const mutate = async (method, body, close = false) => {
    setBusy(true);
    setError("");
    try {
      await requestBudget(connection.id, method, body);
      // Only report saved state after a fresh read of this exact account.
      const persisted = await requestBudget(connection.id);
      setBudget(persisted);
      setForm(toForm(persisted));
      updatedRef.current?.(persisted);
      setConfirmAction(null);
      if (close) onClose();
    } catch (saveError) {
      setError(saveError.message || "Failed to update token limits");
    } finally {
      setBusy(false);
    }
  };

  const handleSave = () => {
    const raw = form.tokenLimit.trim();
    const tokenLimit = raw === "" ? 0 : Number(raw);
    if ((raw !== "" && !/^\d+$/.test(raw)) || !Number.isSafeInteger(tokenLimit) || tokenLimit < 0) {
      setError("Token limit must be a nonnegative safe whole number. Use 0 for unlimited.");
      return;
    }
    return mutate("PUT", { tokenLimit, resetMode: form.resetMode, resetDay: dayValue }, true);
  };

  const close = () => { if (!busy) onClose(); };

  return (
    <Modal
      isOpen={isOpen}
      onClose={close}
      title="Token Limits"
      size="md"
      footer={
        <div className="flex w-full min-w-0 flex-wrap items-center justify-end gap-2">
          <Button variant="secondary" size="lg" onClick={close} disabled={busy}>Cancel</Button>
          <Button size="lg" aria-label="Save" onClick={handleSave} loading={busy} disabled={blocked}>Save</Button>
        </div>
      }
    >
      <div className="flex min-w-0 flex-col gap-4" data-testid="connection-token-budget-modal" aria-busy={loading || busy}>
        <p className="truncate text-sm text-text-muted" title={connection.name}>{connection.name || "This account"}</p>
        {loading ? <p role="status" className="text-sm text-text-muted">Loading token limits…</p> : loaded && (
          <>
            <div className="flex min-w-0 flex-col gap-2 rounded-[10px] bg-surface-2 p-3" aria-label="Tracked token usage">
              <p className="break-words text-sm"><strong>{formatTokens(usage.used)}</strong> / {usage.unlimited ? "Unlimited" : formatTokens(usage.limit)} tokens</p>
              {!usage.unlimited && (
                <>
                  <div role="progressbar" aria-label="Token budget used" aria-valuemin={0} aria-valuemax={100} aria-valuenow={usage.usedPercent} className="h-1.5 w-full overflow-hidden rounded-full bg-surface-3">
                    <div className={`h-full rounded-full ${usage.tone.bg}`} style={{ width: `${usage.usedPercent}%` }} />
                  </div>
                  <p className="text-xs text-text-muted">{formatTokens(usage.remaining)} tokens remaining</p>
                </>
              )}
              {usage.atLimit && <p className="text-xs font-medium text-red-500">Token limit reached</p>}
              {budget?.unknownUsageCount > 0 && <p className="break-words text-xs text-amber-600 dark:text-amber-400">{formatTokens(budget.unknownUsageCount)} requests with unknown usage — tracked totals may be incomplete.</p>}
              <p className="break-words text-xs text-text-muted">Last reset: {budget?.lastResetAt ? new Date(budget.lastResetAt).toLocaleString() : "Never"}</p>
              <p className="break-words text-xs text-text-muted">Next reset: {budget?.nextResetAt ? new Date(budget.nextResetAt).toLocaleString() : "Never"}</p>
            </div>
            <Input
              id="connection-token-limit" label="Token limit" aria-label="Token limit"
              inputMode="numeric" autoComplete="off" placeholder="Unlimited" value={form.tokenLimit}
              disabled={busy} onChange={(event) => update({ tokenLimit: event.target.value })}
              hint="Blank or 0 = unlimited tokens." inputClassName="min-h-11"
            />
            <div className="flex min-w-0 flex-col gap-1.5">
              <label htmlFor="connection-token-reset-mode" className="text-sm font-medium">Reset usage</label>
              <select id="connection-token-reset-mode" aria-label="Reset usage" className={SELECT} value={form.resetMode} disabled={busy}
                onChange={(event) => { const resetMode = event.target.value; update({ resetMode, resetDay: String(resetDayOptions(resetMode)[0]?.value ?? "") }); }}>
                {RESET_MODE_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
              </select>
            </div>
            {days.length > 0 && (
              <div className="flex min-w-0 flex-col gap-1.5">
                <label htmlFor="connection-token-reset-day" className="text-sm font-medium">{form.resetMode === "weekly" ? "Reset weekday" : "Reset day of month"}</label>
                <select id="connection-token-reset-day" aria-label="Reset day" className={SELECT} value={String(dayValue)} disabled={busy} onChange={(event) => update({ resetDay: event.target.value })}>
                  {days.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                </select>
                <p className="text-xs text-text-muted">Resets at midnight Asia/Bangkok (UTC+07:00). Short months use their last day.</p>
              </div>
            )}
            <p className="text-xs text-text-muted">Saving policy changes does not reset usage counters.</p>
            <div className="flex min-w-0 flex-wrap gap-2">
              <Button variant="secondary" size="lg" onClick={() => setConfirmAction("reset")} disabled={busy}>Reset usage now</Button>
              {budget && <Button variant="ghost" size="lg" onClick={() => setConfirmAction("remove")} disabled={busy}>Remove limit</Button>}
            </div>
            {confirmAction && (
              <div role="group" aria-label="Confirm token budget action" className="flex min-w-0 flex-col gap-3 rounded-[10px] border border-border p-3">
                <p className="break-words text-sm">{confirmAction === "reset" ? "Reset tracked tokens and unknown usage counters now? Unsaved policy edits will not be applied." : "Remove this account's token limit and reset policy?"}</p>
                <div className="flex flex-wrap gap-2">
                  <Button variant="secondary" size="lg" onClick={() => setConfirmAction(null)} disabled={busy}>Keep current usage</Button>
                  <Button variant="danger" size="lg" aria-label={confirmAction === "reset" ? "Confirm reset usage" : "Confirm remove limit"} disabled={busy}
                    onClick={() => confirmAction === "reset" ? mutate("PUT", { resetUsage: true }) : mutate("DELETE", undefined, true)}>
                    {confirmAction === "reset" ? "Confirm reset" : "Confirm remove"}
                  </Button>
                </div>
              </div>
            )}
          </>
        )}
        <p className="text-xs text-text-muted">9Router-tracked tokens, not upstream billed tokens.</p>
        <p className="text-xs text-text-muted">Soft cap: already admitted requests finish and can exceed the limit. Account activation and Schedule remain independent.</p>
        {error && <p role="alert" className="break-words text-xs text-red-500">{error}</p>}
        {!loading && error && !loaded && <Button variant="secondary" size="lg" onClick={() => setLoadAttempt((value) => value + 1)}>Retry loading token limits</Button>}
      </div>
    </Modal>
  );
}

ConnectionTokenBudgetModal.propTypes = {
  isOpen: PropTypes.bool.isRequired,
  onClose: PropTypes.func.isRequired,
  connection: PropTypes.shape({ id: PropTypes.string.isRequired, name: PropTypes.string }).isRequired,
  onUpdated: PropTypes.func,
};
