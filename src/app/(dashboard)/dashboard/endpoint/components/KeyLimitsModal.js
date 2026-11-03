"use client";

// Per-key spending limits editor.
//
// Bottom sheet on phones (<=640px) and a centred dialog above it, always with
// its own scroll container (max-h 90dvh) so long content on a short screen does
// not trap the page. Save PATCHes /api/keys/[id] and hands the updated row back
// to the page, which patches it into the list — no reload.
import { useEffect, useRef, useState } from "react";
import PropTypes from "prop-types";
import { Button } from "@/shared/components";
import KeyLimitsFields, { EMPTY_LIMITS } from "./KeyLimitsFields";
import { buildLimitsPayload, buildResetUsagePayload } from "@/shared/utils/keyLimits";

const TITLE_ID = "key-limits-title";

function toFieldValues(apiKey) {
  if (!apiKey) return EMPTY_LIMITS;
  return {
    tokenLimit: apiKey.tokenLimit ? String(apiKey.tokenLimit) : "",
    costLimit: apiKey.costLimit ? String(apiKey.costLimit) : "",
    resetMode: apiKey.resetMode || "none",
    resetDay: apiKey.resetDay == null ? "" : String(apiKey.resetDay),
  };
}

export default function KeyLimitsModal({ isOpen, apiKey, onClose, onSaved, onRequestReset }) {
  const [values, setValues] = useState(() => toFieldValues(apiKey));
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);
  const [resetting, setResetting] = useState(false);
  const valuesKey = `${apiKey?.id || ""}:${isOpen ? "open" : "closed"}`;
  const lastKeyRef = useRef(valuesKey);
  const busy = saving || resetting;

  // Re-seed the form whenever the sheet opens for a (possibly different) key.
  useEffect(() => {
    if (lastKeyRef.current === valuesKey) return;
    lastKeyRef.current = valuesKey;
    setValues(toFieldValues(apiKey));
    setError(null);
  }, [valuesKey, apiKey]);

  // Body scroll lock + Escape, same behaviour as the shared Modal.
  useEffect(() => {
    if (!isOpen) return undefined;
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKeyDown = (e) => {
      if (e.key === "Escape" && !busy) onClose();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.body.style.overflow = previous;
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [isOpen, busy, onClose]);

  const send = async (body) => {
    const res = await fetch(`/api/keys/${apiKey.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      // The API owns validation wording; surface it verbatim, inline.
      throw new Error(data.error || "Failed to update limits");
    }
    return data.key;
  };

  const handleSave = async () => {
    if (busy) return;
    setSaving(true);
    setError(null);
    try {
      const updated = await send(buildLimitsPayload(values));
      onSaved(updated);
      onClose();
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  const handleReset = async () => {
    if (busy) return;
    setError(null);
    // Destructive: the page owns the confirmation dialog.
    onRequestReset(async () => {
      setResetting(true);
      try {
        const updated = await send(buildResetUsagePayload());
        onSaved(updated);
      } catch (err) {
        setError(err.message);
      } finally {
        setResetting(false);
      }
    });
  };

  if (!isOpen || !apiKey) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center sm:items-center sm:p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby={TITLE_ID}
    >
      <div className="absolute inset-0 bg-black/50 backdrop-blur-[2px] fade-in" onClick={busy ? undefined : onClose} />

      <div className="relative flex max-h-[90dvh] w-full flex-col rounded-t-2xl border border-border-subtle bg-surface shadow-[var(--shadow-elev)] fade-in sm:max-h-[85vh] sm:max-w-md sm:rounded-[14px]">
        <div className="flex items-center justify-between gap-2 border-b border-border-subtle p-4">
          <h2 id={TITLE_ID} className="min-w-0 text-base font-semibold">
            <span className="block truncate">Spending limits</span>
            <span className="block truncate text-xs font-normal text-text-muted">{apiKey.name}</span>
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close limits"
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-[10px] text-text-muted transition-colors hover:bg-surface-2 hover:text-text-main"
          >
            <span className="material-symbols-outlined text-[20px]">close</span>
          </button>
        </div>

        <div className="custom-scrollbar min-h-0 flex-1 overflow-y-auto p-4">
          <KeyLimitsFields values={values} onChange={setValues} idPrefix="key-limits" disabled={busy} />

          {error && (
            <p role="alert" className="mt-3 flex items-start gap-1 text-xs text-red-500">
              <span className="material-symbols-outlined text-[14px]">error</span>
              <span className="min-w-0 break-words">{error}</span>
            </p>
          )}
        </div>

        <div className="flex flex-col gap-2 border-t border-border-subtle p-4 sm:flex-row-reverse">
          <Button size="lg" onClick={handleSave} loading={saving} disabled={busy} className="w-full sm:w-auto">
            Save
          </Button>
          <Button
            size="lg"
            variant="secondary"
            onClick={handleReset}
            loading={resetting}
            disabled={busy}
            className="w-full sm:w-auto"
          >
            Reset usage now
          </Button>
        </div>
      </div>
    </div>
  );
}

KeyLimitsModal.propTypes = {
  isOpen: PropTypes.bool.isRequired,
  apiKey: PropTypes.shape({
    id: PropTypes.string.isRequired,
    name: PropTypes.string,
    tokenLimit: PropTypes.number,
    costLimit: PropTypes.number,
    usedTokens: PropTypes.number,
    usedCost: PropTypes.number,
    resetMode: PropTypes.oneOf(["none", "monthly", "weekly"]),
    resetDay: PropTypes.number,
    lastResetAt: PropTypes.string,
  }),
  onClose: PropTypes.func.isRequired,
  onSaved: PropTypes.func.isRequired,
  onRequestReset: PropTypes.func.isRequired,
};
