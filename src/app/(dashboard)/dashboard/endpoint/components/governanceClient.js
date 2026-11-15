// Same-origin administrative APIs only. Never fabricate a persisted result.
export async function governanceRequest(url, options) {
  const res = await fetch(url, { cache: "no-store", ...options });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "Governance request failed. Please retry.");
  return data;
}
