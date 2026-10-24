"use client";

import { useMemo, useState } from "react";
import Modal from "@/shared/components/Modal";
import Button from "@/shared/components/Button";
import { SLOW_THRESHOLD_MS, buildHealthSummary, formatLatency } from "./healthCheckUtils";

const FILTERS = [
  { id: "all", label: "All" },
  { id: "failed", label: "Failed" },
  { id: "slow", label: "Slow" },
];

function StatusIcon({ entry }) {
  if (entry.pending) {
    return <span className="material-symbols-outlined text-[16px] text-text-muted" style={{ animation: "spin 1s linear infinite" }}>progress_activity</span>;
  }
  if (entry.ok) {
    return <span className="material-symbols-outlined text-[16px] text-green-500">check_circle</span>;
  }
  return <span className="material-symbols-outlined text-[16px] text-red-500">cancel</span>;
}

/**
 * Summary for a model health check run.
 * Results are `{ modelId, name, ok, latencyMs, error, pending }` in display order.
 */
export default function HealthCheckModal({
  isOpen,
  onClose,
  providerLabel = "",
  running = false,
  progress = { done: 0, total: 0 },
  results = [],
  finishedAt = null,
  onStop,
  onRerunFailed,
  onRerunAll,
}) {
  const [filter, setFilter] = useState("all");

  const summary = useMemo(() => buildHealthSummary(results), [results]);

  const visibleRows = useMemo(() => {
    if (filter === "failed") return results.filter((r) => !r.pending && !r.ok);
    if (filter === "slow") return results.filter((r) => !r.pending && r.ok && r.latencyMs >= SLOW_THRESHOLD_MS);
    return results;
  }, [results, filter]);

  const failedIds = useMemo(
    () => results.filter((r) => !r.pending && !r.ok).map((r) => r.modelId),
    [results]
  );

  const copyReport = async () => {
    const lines = [
      `# 9router model health check${providerLabel ? ` — ${providerLabel}` : ""}`,
      `# ${new Date(finishedAt || Date.now()).toISOString()}`,
      "status\tmodel\tlatency_ms\terror",
      ...results.map((r) => `${r.pending ? "pending" : r.ok ? "ok" : "failed"}\t${r.modelId}\t${r.latencyMs ?? ""}\t${r.error || ""}`),
    ];
    try {
      await navigator.clipboard.writeText(lines.join("\n"));
    } catch {
      /* clipboard unavailable (http origin) — silently ignore */
    }
  };

  const footer = (
    <>
      <Button size="sm" variant="ghost" icon="content_copy" onClick={copyReport} disabled={results.length === 0}>
        Copy
      </Button>
      {running ? (
        <Button size="sm" variant="danger" icon="stop" onClick={onStop}>
          Stop
        </Button>
      ) : (
        <>
          {failedIds.length > 0 && (
            <Button size="sm" variant="secondary" icon="replay" onClick={() => onRerunFailed?.(failedIds)}>
              Re-run failed ({failedIds.length})
            </Button>
          )}
          <Button size="sm" variant="primary" icon="refresh" onClick={onRerunAll}>
            Re-run all
          </Button>
        </>
      )}
    </>
  );

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title="Model Health Check"
      size="full"
      footer={footer}
    >
      <div className="space-y-4">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs">
          <span className="font-medium text-text-primary">
            {running ? `Checking ${progress.done}/${progress.total}…` : `${summary.total} total`}
          </span>
          <span className="flex items-center gap-1 text-green-600 dark:text-green-400">
            <span className="material-symbols-outlined text-[14px]">check_circle</span>
            {summary.passed} passed
          </span>
          <span className="flex items-center gap-1 text-red-500">
            <span className="material-symbols-outlined text-[14px]">cancel</span>
            {summary.failed} failed
          </span>
          {summary.avg !== null && (
            <span className="text-text-muted">avg {formatLatency(summary.avg)}</span>
          )}
          {summary.slow > 0 && (
            <span className="text-amber-500">{summary.slow} slow (&gt;{SLOW_THRESHOLD_MS / 1000}s)</span>
          )}
        </div>

        {running && (
          <div className="h-1 w-full overflow-hidden rounded-full bg-black/10 dark:bg-white/10">
            <div
              className="h-full rounded-full bg-primary transition-all duration-300"
              style={{ width: `${progress.total ? Math.round((progress.done / progress.total) * 100) : 0}%` }}
            />
          </div>
        )}

        <div className="flex items-center gap-1.5">
          {FILTERS.map((item) => {
            const active = filter === item.id;
            const count = item.id === "failed" ? summary.failed : item.id === "slow" ? summary.slow : summary.total;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => setFilter(item.id)}
                className={`rounded-md border px-2 py-1 text-[11px] transition-colors ${
                  active
                    ? "border-primary/40 bg-primary/10 text-primary"
                    : "border-black/10 text-text-muted hover:bg-black/5 dark:border-white/10 dark:hover:bg-white/5"
                }`}
              >
                {item.label} ({count})
              </button>
            );
          })}
        </div>

        {visibleRows.length === 0 ? (
          <p className="py-6 text-center text-xs text-text-muted">
            {results.length === 0 ? "No models to test." : "Nothing matches this filter."}
          </p>
        ) : (
          <div className="overflow-hidden rounded-lg border border-black/5 dark:border-white/5">
            <table className="w-full table-fixed text-left text-xs">
              <thead className="bg-black/[0.02] text-[10px] uppercase tracking-wide text-text-muted dark:bg-white/[0.03]">
                <tr>
                  <th className="w-8 px-2 py-1.5"><span className="sr-only">Status</span></th>
                  <th className="px-2 py-1.5">Model</th>
                  <th className="w-20 px-2 py-1.5 text-right">Latency</th>
                  <th className="w-1/3 px-2 py-1.5">Error</th>
                </tr>
              </thead>
              <tbody>
                {visibleRows.map((entry) => (
                  <tr key={entry.modelId} className="border-t border-black/5 align-top dark:border-white/5">
                    <td className="px-2 py-1.5"><StatusIcon entry={entry} /></td>
                    <td className="min-w-0 px-2 py-1.5">
                      <code className="block break-all font-mono text-[11px] text-text-primary">{entry.modelId}</code>
                      {entry.name && entry.name !== entry.modelId && (
                        <span className="block text-[10px] italic text-text-muted/70">{entry.name}</span>
                      )}
                    </td>
                    <td className="px-2 py-1.5 text-right tabular-nums text-text-muted">
                      {entry.pending ? "—" : formatLatency(entry.latencyMs)}
                    </td>
                    <td className="px-2 py-1.5">
                      {entry.error ? (
                        <span className="block break-words text-[11px] text-red-500" title={entry.error}>
                          {String(entry.error).slice(0, 240)}
                        </span>
                      ) : (
                        <span className="text-text-muted/50">—</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </Modal>
  );
}
