"use client";

import { useEffect, useId, useRef, useState } from "react";
import AccessGroupSettings from "./AccessGroupSettings";

const TABS = [{ id: "keys", label: "Keys" }, { id: "groups", label: "Group Settings" }];
const readTab = () => new URLSearchParams(window.location.search).get("tab") === "groups" ? "groups" : "keys";

export default function EndpointTabs({ children, onKeysSelected }) {
  const id = useId();
  const [tab, setTab] = useState(null);
  const [refreshError, setRefreshError] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const buttons = useRef({});
  const current = useRef(null);
  const refresh = useRef(onKeysSelected);
  refresh.current = onKeysSelected;
  const sequence = useRef(0);

  const select = async (next) => {
    if (current.current === next) return;
    const initial = current.current === null;
    current.current = next;
    const request = ++sequence.current;
    setTab(next); setRefreshError("");
    if (next !== "keys") { setRefreshing(false); return; }
    setRefreshing(true);
    try { await refresh.current?.(initial); }
    catch (err) { if (sequence.current === request) setRefreshError(err.message || "Unable to refresh keys. Please retry."); }
    finally { if (sequence.current === request) setRefreshing(false); }
  };
  useEffect(() => {
    select(readTab());
    const back = () => select(readTab());
    window.addEventListener("popstate", back);
    return () => { window.removeEventListener("popstate", back); };
  }, []);

  const navigate = (next, focus = false) => {
    if (next !== current.current) {
      const url = new URL(window.location.href);
      url.searchParams.set("tab", next);
      // Native shallow history is supported by Next; preserve other query values and hash.
      window.history.pushState(null, "", `${url.pathname}${url.search}${url.hash}`);
      select(next);
    }
    if (focus) buttons.current[next]?.focus();
  };
  return (
    <div className="flex min-w-0 flex-col gap-6">
      <div role="tablist" aria-label="Endpoint settings" className="grid min-w-0 grid-cols-2 gap-1 rounded-[10px] border border-border-subtle bg-surface-2 p-1 sm:flex sm:w-fit">
        {TABS.map((item, index) => <button key={item.id} type="button" role="tab" id={`${id}-${item.id}-tab`} aria-controls={`${id}-${item.id}-panel`} aria-selected={tab === item.id} tabIndex={tab === item.id || (tab === null && index === 0) ? 0 : -1} ref={(node) => { buttons.current[item.id] = node; }} className={`min-h-11 min-w-0 rounded-lg px-3 py-2 text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary ${tab === item.id ? "bg-surface text-primary shadow-sm" : "text-text-muted hover:text-text-main"}`} onClick={() => navigate(item.id)} onKeyDown={(event) => {
          let next;
          if (event.key === "ArrowRight" || event.key === "ArrowLeft") next = TABS[(index + 1) % TABS.length].id;
          if (event.key === "Home") next = "keys";
          if (event.key === "End") next = "groups";
          if (next) { event.preventDefault(); navigate(next, true); }
        }}>{item.label}</button>)}
      </div>
      {tab === null ? <p role="status">Loading endpoint settings…</p> : TABS.map((item) => <section key={item.id} role="tabpanel" id={`${id}-${item.id}-panel`} aria-labelledby={`${id}-${item.id}-tab`} hidden={tab !== item.id} tabIndex={0} className="min-w-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary">
        {tab === item.id && (item.id === "groups" ? <div className="min-w-0 rounded-[14px] border border-border-subtle bg-surface p-4 sm:p-6"><AccessGroupSettings /></div> : refreshing ? <p role="status">Refreshing keys and effective policies…</p> : refreshError ? <div><p role="alert" className="break-words text-sm text-red-500">{refreshError}</p><button type="button" className="min-h-11 text-sm text-primary" onClick={() => { current.current = null; select("keys"); }}>Retry keys refresh</button></div> : children)}
      </section>)}
    </div>
  );
}
