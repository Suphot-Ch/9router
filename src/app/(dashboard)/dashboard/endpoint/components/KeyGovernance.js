"use client";

import { useState } from "react";
import Button from "@/shared/components/Button";
import Input from "@/shared/components/Input";
import KeyAccessPolicy from "./KeyAccessPolicy";

import { governanceRequest } from "./governanceClient";
import KeyBudgetAlerts from "./KeyBudgetAlerts";

export function integerLimit(value) {
  const text = String(value).trim();
  if (text !== "" && !/^\d+$/.test(text)) throw new Error("Minute limits must be whole numbers, 0 for unlimited.");
  const number = Number(text || 0);
  if (!Number.isSafeInteger(number)) throw new Error("Minute limits must be safe integers.");
  return number;
}

export default function KeyGovernance({ apiKey, onSaved }) {
  const [rpm, setRpm] = useState(String(apiKey.rpmLimit ?? 0));
  const [tpm, setTpm] = useState(String(apiKey.tpmLimit ?? 0));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const readKey = async () => {
    const { key } = await governanceRequest(`/api/keys/${encodeURIComponent(apiKey.id)}`);
    if (!key) throw new Error("Saved, but key readback was unavailable. Refresh before retrying.");
    onSaved(key);
    return key;
  };
  const savePolicy = async (body) => {
    await governanceRequest(`/api/keys/${encodeURIComponent(apiKey.id)}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    return readKey();
  };
  const saveRates = async () => {
    if (busy) return;
    setError(""); setNotice(""); setBusy(true);
    try {
      await governanceRequest(`/api/keys/${encodeURIComponent(apiKey.id)}`, {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rpmLimit: integerLimit(rpm), tpmLimit: integerLimit(tpm) }),
      });
      const { key } = await governanceRequest(`/api/keys/${encodeURIComponent(apiKey.id)}`);
      if (!key) throw new Error("Saved, but key readback was unavailable. Refresh before retrying.");
      onSaved(key);
      setRpm(String(key.rpmLimit ?? 0)); setTpm(String(key.tpmLimit ?? 0));
      setNotice("Saved minute limits");
    } catch (err) { setError(err.message); }
    finally { setBusy(false); }
  };
  const rate = apiKey.rateStatus;
  const refresh = async () => {
    if (busy) return;
    setBusy(true); setError(""); setNotice("");
    try { await readKey(); setNotice("Refreshed server status"); }
    catch (err) { setError(err.message); }
    finally { setBusy(false); }
  };
  return (
    <details className="mt-3 min-w-0 rounded-[10px] border border-border-subtle p-3">
      <summary className="min-h-11 cursor-pointer py-2 text-sm font-medium text-text-main">Key governance</summary>
      <section aria-label="Minute limits" className="flex min-w-0 flex-col gap-3 pt-3">
        <h4 className="text-sm font-semibold">Soft minute limits</h4>
        <div className="rounded border border-border-subtle bg-surface-2 p-3 text-xs text-text-muted" aria-label="Observed minute status">
          {rate ? <>
            <p>{rate.rpm?.used == null ? "RPM status unavailable" : `${rate.rpm.used} requests observed`}</p>
            <p>{rate.tpm?.used == null ? "TPM usage unknown" : `${rate.tpm.used} actual tokens observed`}</p>
            <p>{`TPM coverage: ${rate.tpm?.coverage || "unknown"} · ${rate.inFlight ?? "unknown"} in-flight`}</p>
            {rate.warmingUp && <p className="text-orange-600 dark:text-orange-400">Warming up after process start; minute history may be incomplete.</p>}
            {rate.deploymentConfigured === false && <p className="text-orange-600 dark:text-orange-400">Single-process deployment not confirmed; rate enforcement may reject configured keys.</p>}
          </> : <p>Minute status unavailable — not assumed to be zero.</p>}
          <Button variant="ghost" disabled={busy} onClick={refresh}>Refresh server status</Button>
        </div>
        <div className="grid min-w-0 gap-3 sm:grid-cols-2">
          <Input label="Requests per minute (RPM)" aria-label="Requests per minute (RPM)" inputMode="numeric" value={rpm} onChange={(e) => setRpm(e.target.value)} disabled={busy} hint="Whole numbers only. Blank or 0 = unlimited." />
          <Input label="Tokens per minute (TPM)" aria-label="Tokens per minute (TPM)" inputMode="numeric" value={tpm} onChange={(e) => setTpm(e.target.value)} disabled={busy} hint="Actual prompt + completion tokens. 0 = unlimited." />
        </div>
        <p className="text-xs text-text-muted">Rolling 60 seconds, single-process MVP. A restart loses minute counters and starts a warm-up window. Admitted in-flight streams finish: TPM overshoot is not bounded. Unknown token usage reduces TPM coverage; unknown pricing is not free. Period budgets and their reset controls remain separate. Saving policy does not reset minute counters.</p>
        <Button size="lg" onClick={saveRates} disabled={busy} loading={busy}>Save minute limits</Button>
      </section>
      <KeyAccessPolicy apiKey={apiKey} onSave={savePolicy} disabled={busy} />
      <KeyBudgetAlerts apiKey={apiKey} onSave={savePolicy} disabled={busy} />
      {error && <p role="alert" className="mt-3 break-words text-sm text-red-500">{error}</p>}
      {notice && <p role="status" className="mt-3 text-sm text-green-600 dark:text-green-400">{notice}</p>}
    </details>
  );
}
