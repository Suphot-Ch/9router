"use client";

import { useEffect, useId, useState } from "react";
import Button from "@/shared/components/Button";

import { governanceRequest } from "./governanceClient";

const SELECT = "h-11 w-full min-w-0 rounded-[10px] border border-border-subtle bg-surface-2 px-3 text-sm text-text-main focus:outline-none focus:ring-2 focus:ring-brand-500/30 disabled:opacity-50";

export default function KeyAccessPolicy({ apiKey, onSave, disabled }) {
  const id = useId();
  const [mode, setMode] = useState(apiKey.accessMode || "local");
  const [groupId, setGroupId] = useState(apiKey.accessGroupId || "");
  const [groups, setGroups] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const locked = disabled || busy;

  useEffect(() => {
    let active = true;
    governanceRequest("/api/access-groups").then((data) => {
      if (!Array.isArray(data.groups)) throw new Error("Invalid access group response. Please retry.");
      if (active) setGroups(data.groups);
    }).catch((err) => { if (active) setError(err.message); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, []);

  const run = async (action) => {
    if (locked) return;
    setBusy(true); setError(""); setNotice("");
    try { await action(); }
    catch (err) { setError(err.message); }
    finally { setBusy(false); }
  };
  const savePolicy = () => run(async () => {
    if (mode !== "local" && !groups.some((g) => g.id === groupId)) throw new Error("Choose an available access group first. Missing groups deny access.");
    await onSave({ accessMode: mode, accessGroupId: groupId || null });
    setNotice("Saved access policy");
  });

  return (
    <section aria-label="Access policy and groups" className="mt-5 flex min-w-0 flex-col gap-3 border-t border-border-subtle pt-4">
      <h4 className="text-sm font-semibold">Access policy</h4>
      <p className="text-xs text-text-muted">Local uses the existing key allowlist above. Group uses only its shared allowlist. Intersection permits only access allowed by both. Missing or corrupt groups deny access; switching mode does not erase the local allowlist.</p>
      {loading && <p role="status" className="text-sm text-text-muted">Loading access groups…</p>}
      <div className="grid min-w-0 gap-3 sm:grid-cols-2">
        <label htmlFor={`${id}-mode`} className="text-sm">Access policy mode
          <select id={`${id}-mode`} aria-label="Access policy mode" className={SELECT} value={mode} disabled={locked} onChange={(e) => setMode(e.target.value)}>
            <option value="local">Local key allowlist</option><option value="group">Access group</option><option value="intersection">Intersection (local ∩ group)</option>
          </select>
        </label>
        <label htmlFor={`${id}-group`} className="text-sm">Access group
          <select id={`${id}-group`} aria-label="Access group" className={SELECT} value={groupId} disabled={locked || loading} onChange={(e) => setGroupId(e.target.value)}>
            <option value="">Select group</option>
            {groupId && !groups.some((g) => g.id === groupId) && <option value={groupId}>Missing group — access denied</option>}
            {groups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
          </select>
        </label>
      </div>
      <div className="min-w-0 rounded border border-border-subtle bg-surface-2 p-3 text-xs text-text-muted" aria-label="Server effective access">
        <p className="font-medium">Server effective access</p>
        {!apiKey.effectiveAccess ? <p>Not available. Refresh server status before relying on this policy.</p> : <>
          {apiKey.effectiveAccess.source === "missing-or-corrupt-group" && <p className="text-orange-600 dark:text-orange-400">Missing or corrupt group — access denied.</p>}
          {apiKey.effectiveAccess.mode === "intersection" && <p>All policies below must allow the request. Entries are not a raw-string intersection; combo and provider matching is evaluated by the server.</p>}
          {(apiKey.effectiveAccess.policies || [apiKey.effectiveAccess]).map((policy, index) => <div key={index} className="mt-2">
            {apiKey.effectiveAccess.mode === "intersection" && <p className="font-medium">{index === 0 ? "Group policy" : "Local policy"}</p>}
            {!policy.restricted ? <p>Unrestricted by this policy. Other security and provider controls still apply.</p> : policy.allow?.length ? <ul className="mt-1 flex flex-wrap gap-1">{policy.allow.map((entry) => <li key={entry} className="max-w-full break-all rounded border border-border-subtle px-2 py-1 font-mono">{entry}</li>)}</ul> : <p className="text-orange-600 dark:text-orange-400">No combos or models allowed — access denied.</p>}
          </div>)}
        </>}
        <p className="mt-1">Last server snapshot; unsaved selections above do not change effective access.</p>
      </div>
      <Button size="lg" disabled={locked || (mode !== "local" && loading)} onClick={savePolicy}>Save access policy</Button>
      {error && <div><p role="alert" className="break-words text-sm text-red-500">{error}</p><Button variant="ghost" disabled={locked} onClick={() => run(async () => {
        const data = await governanceRequest("/api/access-groups");
        if (!Array.isArray(data.groups)) throw new Error("Invalid access group response. Please retry.");
        setGroups(data.groups);
      })}>Refresh groups</Button></div>}
      {notice && <p role="status" className="text-sm text-green-600 dark:text-green-400">{notice}</p>}
    </section>
  );
}
