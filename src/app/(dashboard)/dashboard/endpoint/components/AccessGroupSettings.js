"use client";

import { useEffect, useState } from "react";
import Button from "@/shared/components/Button";
import Input from "@/shared/components/Input";
import KeyAccessControls from "./KeyAccessControls";
import { governanceRequest } from "./governanceClient";

// Shared policies are managed independently of API keys, including an empty key list.
export default function AccessGroupSettings() {
  const [groups, setGroups] = useState([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [draft, setDraft] = useState(null);
  const [confirm, setConfirm] = useState(null);
  const load = async () => {
    const data = await governanceRequest("/api/access-groups");
    if (!Array.isArray(data.groups)) throw new Error("Invalid access group response. Please retry.");
    setGroups(data.groups);
    return data.groups;
  };
  useEffect(() => {
    let active = true;
    governanceRequest("/api/access-groups").then((data) => {
      if (!Array.isArray(data.groups)) throw new Error("Invalid access group response. Please retry.");
      if (active) setGroups(data.groups);
    }).catch((err) => { if (active) setError(err.message); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, []);
  const run = async (action) => {
    if (busy) return;
    setBusy(true); setError(""); setNotice("");
    try { await action(); }
    catch (err) { setError(err.message); }
    finally { setBusy(false); }
  };

  return (
    <section aria-label="Shared access groups" className="flex min-w-0 flex-col gap-4">
      <div>
        <h2 className="text-lg font-semibold">Group Settings</h2>
        <p className="mt-1 text-sm text-text-muted">Manage shared model access once, then assign groups from the Keys tab.</p>
        <p className="mt-2 text-sm text-orange-600 dark:text-orange-400">Editing a shared group immediately affects every key using it. Referenced groups cannot be deleted.</p>
      </div>
      {loading ? <p role="status" className="text-sm text-text-muted">Loading access groups…</p> : <>
        {groups.length === 0 && !error && <p className="text-sm text-text-muted">No access groups yet. Create a group without creating an API key.</p>}
        <ul className="flex min-w-0 flex-col gap-3">
          {groups.map((g) => <li key={g.id} className="flex min-w-0 flex-col gap-2 rounded-[10px] border border-border-subtle p-3 sm:flex-row sm:items-center">
            <div className="min-w-0 flex-1">
              <h3 className="break-all text-sm font-medium">{g.name}</h3>
              <p className="text-xs text-text-muted">{g.access?.restricted ? `${g.access.allow?.length ?? 0} allowed entries` : "Unrestricted"}</p>
              <p className="text-xs text-text-muted">{Number.isInteger(g.memberCount) ? `${g.memberCount} ${g.memberCount === 1 ? "key" : "keys"}` : "Member count unavailable"}</p>
            </div>
            <div className="flex min-w-0 flex-wrap gap-2">
              <Button size="lg" variant="secondary" className="min-h-11" disabled={busy} aria-label={`Edit ${g.name}`} onClick={() => { setDraft({ id: g.id, name: g.name, access: g.access || { restricted: true, allow: [] } }); setConfirm(null); setError(""); setNotice(""); }}>Edit</Button>
              <Button size="lg" variant="ghost" className="min-h-11" disabled={busy} aria-label={`Delete ${g.name}`} onClick={() => { setConfirm({ type: "delete", group: g }); setError(""); setNotice(""); }}>Delete</Button>
            </div>
          </li>)}
        </ul>
      </>}
      <div className="flex flex-wrap gap-2">
        <Button size="lg" variant="secondary" disabled={busy} onClick={() => { setDraft({ name: "", access: { restricted: true, allow: [] } }); setConfirm(null); setError(""); setNotice(""); }}>New access group</Button>
        <Button size="lg" variant="ghost" disabled={busy || loading} onClick={() => run(load)}>Refresh groups</Button>
      </div>
      {draft && <fieldset disabled={busy} className="min-w-0 rounded-[10px] border border-border-subtle p-3">
        <legend className="text-sm font-medium">{draft.id ? "Edit shared group" : "Create shared group"}</legend>
        <Input label="Group name" aria-label="Group name" value={draft.name} onChange={(e) => { setDraft({ ...draft, name: e.target.value }); setConfirm(null); }} />
        <KeyAccessControls subject="group" apiKey={{ id: draft.id || "new-group", name: draft.name || "New group", access: draft.access }} onChange={(access) => { setDraft({ ...draft, access }); setConfirm(null); }} onRequestRestrict={() => setConfirm({ type: "restrict" })} />
        <div className="mt-3 flex flex-wrap gap-2">
          <Button size="lg" disabled={busy} onClick={() => { setError(""); if (!draft.name.trim()) { setError("Group name is required."); return; } setConfirm({ type: "save", draft }); }}>{draft.id ? "Save group" : "Create group"}</Button>
          <Button size="lg" variant="ghost" disabled={busy} onClick={() => { setDraft(null); setConfirm(null); }}>Cancel group editing</Button>
        </div>
      </fieldset>}
      {confirm && <div role="group" aria-label="Confirm shared group change" className="min-w-0 rounded-[10px] border border-orange-500/30 bg-surface-2 p-3 text-sm">
        <p className="break-all">{confirm.type === "delete" ? `Delete shared group “${confirm.group.name}”? This cannot be undone. Referenced groups cannot be deleted.` : confirm.type === "restrict" ? "Restrict this group? An empty allowlist denies all access." : `Save shared group “${confirm.draft.name.trim()}”? This policy immediately affects every key using the group.`}</p>
        <div className="mt-3 flex flex-wrap gap-2">
          <Button size="lg" disabled={busy} loading={busy} variant={confirm.type === "delete" ? "danger" : "primary"} onClick={() => run(async () => {
            if (confirm.type === "restrict") { setDraft({ ...draft, access: { ...draft.access, restricted: true } }); setConfirm(null); return; }
            if (confirm.type === "delete") {
              await governanceRequest(`/api/access-groups/${encodeURIComponent(confirm.group.id)}`, { method: "DELETE" });
              const fresh = await load();
              if (fresh.some((g) => g.id === confirm.group.id)) throw new Error("Deletion not confirmed. Refresh groups before retrying.");
              if (draft?.id === confirm.group.id) setDraft(null);
              setNotice("Deleted access group");
            } else {
              const target = confirm.draft;
              const result = await governanceRequest(target.id ? `/api/access-groups/${encodeURIComponent(target.id)}` : "/api/access-groups", {
                method: target.id ? "PUT" : "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: target.name.trim(), access: target.access }),
              });
              const fresh = await load();
              const persisted = fresh.find((g) => g.id === (target.id || result.group?.id));
              if (!persisted || persisted.name !== target.name.trim() || persisted.access?.restricted !== target.access.restricted || JSON.stringify(persisted.access?.allow) !== JSON.stringify(target.access.allow)) throw new Error("Save not confirmed. Refresh groups before retrying.");
              setDraft(null); setNotice("Saved access group");
            }
            setConfirm(null);
          })}>{confirm.type === "delete" ? "Confirm delete group" : confirm.type === "restrict" ? "Confirm group restriction" : "Confirm save group"}</Button>
          <Button size="lg" variant="ghost" disabled={busy} onClick={() => setConfirm(null)}>Cancel confirmation</Button>
        </div>
      </div>}
      {error && <p role="alert" className="break-words text-sm text-red-500">{error}</p>}
      {notice && <p role="status" className="text-sm text-green-600 dark:text-green-400">{notice}</p>}
    </section>
  );
}
