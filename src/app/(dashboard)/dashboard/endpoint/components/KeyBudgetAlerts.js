"use client";

import { useEffect, useId, useState } from "react";
import Button from "@/shared/components/Button";
import Input from "@/shared/components/Input";
import { governanceRequest } from "./governanceClient";

export function alertThresholds(value) {
  const parts = String(value).split(",").map((v) => v.trim());
  if (!parts.length || parts.some((v) => !/^\d+$/.test(v) || Number(v) < 1 || Number(v) > 100)) {
    throw new Error("Enter comma-separated whole percentages from 1 to 100.");
  }
  return [...new Set(parts.map(Number))].sort((a, b) => a - b);
}

export default function KeyBudgetAlerts({ apiKey, onSave, disabled }) {
  const id = useId();
  const [enabled, setEnabled] = useState(apiKey.alertsEnabled !== false);
  const [thresholds, setThresholds] = useState((apiKey.alertThresholds || [80, 90, 100]).join(", "));
  const [alerts, setAlerts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const locked = disabled || busy;
  const url = `/api/keys/alerts?keyId=${encodeURIComponent(apiKey.id)}&limit=100`;
  const readAlerts = async () => {
    const data = await governanceRequest(url);
    if (!Array.isArray(data.alerts)) throw new Error("Invalid alert inbox response. Please retry.");
    return data.alerts;
  };
  useEffect(() => {
    let active = true;
    governanceRequest(url).then((data) => {
      if (!Array.isArray(data.alerts)) throw new Error("Invalid alert inbox response. Please retry.");
      if (active) setAlerts(data.alerts);
    }).catch((err) => { if (active) setError(err.message); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [url]);
  const run = async (action) => {
    if (locked) return;
    setBusy(true); setError(""); setNotice("");
    try { await action(); } catch (err) { setError(err.message); }
    finally { setBusy(false); }
  };
  const save = () => run(async () => {
    const key = await onSave({ alertsEnabled: enabled, alertThresholds: alertThresholds(thresholds) });
    setEnabled(key.alertsEnabled !== false); setThresholds((key.alertThresholds || []).join(", "));
    setNotice("Saved alert settings");
  });
  const acknowledge = (alert) => run(async () => {
    await governanceRequest(`/api/keys/alerts/${encodeURIComponent(alert.id)}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ acknowledged: true }),
    });
    const fresh = await readAlerts();
    setAlerts(fresh);
    if (!fresh.find((item) => item.id === alert.id)?.acknowledgedAt) throw new Error("Acknowledgement not confirmed by inbox readback. Refresh before retrying.");
    setNotice("Acknowledged alert");
  });
  return (
    <section aria-label="Budget alerts" className="mt-5 flex min-w-0 flex-col gap-3 border-t border-border-subtle pt-4">
      <h4 className="text-sm font-semibold">Budget alert settings</h4>
      <label htmlFor={`${id}-enabled`} className="flex min-h-11 items-center gap-2 text-sm">
        <input id={`${id}-enabled`} type="checkbox" checked={enabled} disabled={locked} onChange={(e) => setEnabled(e.target.checked)} className="size-5 accent-brand-500" />
        Enable budget alerts
      </label>
      <Input label="Budget alert thresholds (%)" aria-label="Budget alert thresholds (%)" value={thresholds} onChange={(e) => setThresholds(e.target.value)} disabled={locked} hint="Comma-separated integers 1–100, e.g. 80, 90, 100. Sorted and deduplicated when saved." />
      <p className="text-xs text-text-muted">Applies to existing token and USD period budgets, not minute limits. Inbox only: no email or external sends. Unknown pricing remains unknown, never free. Disabling alerts does not remove previous inbox entries.</p>
      <Button size="lg" disabled={locked} onClick={save}>Save alert settings</Button>
      <details className="min-w-0 rounded-[10px] border border-border-subtle p-3">
        <summary className="min-h-11 cursor-pointer py-2 text-sm font-medium">Budget alert inbox</summary>
        <p className="mb-2 text-xs text-text-muted">Latest 100 retained alerts for this key. No unread total is inferred from this limited list.</p>
        <Button variant="secondary" disabled={locked || loading} onClick={() => run(async () => { setAlerts(await readAlerts()); })}>Refresh inbox</Button>
        {loading ? <p role="status" className="mt-3 text-sm text-text-muted">Loading budget alerts…</p> : <>
          {alerts.length === 0 && !error && <p className="mt-3 text-sm text-text-muted">No budget alerts for this key.</p>}
          <ul className="mt-3 flex min-w-0 flex-col gap-3">
            {alerts.map((alert) => <li key={alert.id} className="min-w-0 rounded border border-border-subtle p-3 text-sm">
              <p className="font-medium">{`${alert.threshold}% ${alert.metric} budget`}</p>
              <p className="break-words text-xs text-text-muted">{`Used ${alert.used ?? "unknown"} of ${alert.limit ?? "unknown"} · Period ${alert.period}`}</p>
              <p className="break-words text-xs text-text-muted">{new Date(alert.createdAt).toLocaleString()}</p>
              {alert.acknowledgedAt ? <p className="mt-2 text-xs text-text-muted">Acknowledged · {new Date(alert.acknowledgedAt).toLocaleString()}</p> : <Button size="lg" variant="secondary" disabled={locked} onClick={() => acknowledge(alert)}>Acknowledge alert</Button>}
            </li>)}
          </ul>
        </>}
      </details>
      {error && <p role="alert" className="break-words text-sm text-red-500">{error}</p>}
      {notice && <p role="status" className="text-sm text-green-600 dark:text-green-400">{notice}</p>}
    </section>
  );
}
