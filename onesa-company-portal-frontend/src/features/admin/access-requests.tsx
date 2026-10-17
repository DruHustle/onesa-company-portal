"use client";
import { useEffect, useState, type FormEvent } from "react";
import { api } from "@/lib/api/client";
import type { operations } from "@/lib/api/generated/schema";
type Request = operations["listAccessRequests"]["responses"][200]["content"]["application/json"]["items"][number];
export function AccessRequests() {
  const [items, setItems] = useState<Request[]>([]), [selected, setSelected] = useState<Request | null>(null), [busy, setBusy] = useState(false), [notice, setNotice] = useState("");
  async function load() { const result = await api.GET("/api/v1/admin/access/requests"); setItems(result.data!.items); }
  useEffect(() => { let active = true; api.GET("/api/v1/admin/access/requests").then(r => { if (active) setItems(r.data!.items); }).catch(() => { if (active) setNotice("Access requests could not be loaded."); }); return () => { active = false; }; }, []);
  async function review(e: FormEvent<HTMLFormElement>) {
    e.preventDefault(); if (!selected || busy) return; const data = new FormData(e.currentTarget); setBusy(true); setNotice("");
    try {
      await api.POST("/api/v1/admin/access/requests/{id}/review", { params: { path: { id: selected.id } }, body: { decision: String(data.get("decision")) as "approve" | "reject", expectedRevision: selected.revision, evidence: String(data.get("evidence")), role: String(data.get("role") || "viewer") as "administrator" | "editor" | "business" | "hr" | "viewer", password: String(data.get("password")), code: String(data.get("code")) } });
      setSelected(null); await load(); setNotice("Review recorded. The applicant’s notification has been queued; delivery is tracked by the mail worker.");
    } catch (error) { setNotice(error instanceof Error ? error.message : "The review could not be saved."); }
    finally { setBusy(false); }
  }
  return <section aria-labelledby="access-requests-title"><h2 id="access-requests-title">Access requests</h2><p>Only email-verified registrations appear here. Administrator and Engineering Docs approvals are separate. Review the requested scope before granting access.</p>
    {notice && <p role="status">{notice}</p>}
    <button type="button" disabled={busy} onClick={() => void load().catch(() => setNotice("Access requests could not be loaded."))}>Refresh access requests</button>
    {items.length === 0 && <p>No verified access requests.</p>}
    <div className="admin-grid"><div className="admin-list">{items.map(item => <button type="button" key={item.id} disabled={busy || item.state !== "pending"} aria-pressed={selected?.id === item.id} onClick={() => setSelected(item)}>{item.display_name} · {item.email}<small>{item.audience === "admin" ? "Company administration" : "Engineering Docs"} · {item.state}</small></button>)}</div>
      {selected && <form key={selected.id} onSubmit={review} className="admin-card" aria-busy={busy}><fieldset disabled={busy}><legend>Review {selected.email}</legend>
        <p>{selected.audience === "engineering" ? "Confirm the exact-email Docs Access policy and alias bindings first. This approval grants no Portal administration role." : "Choose the minimum necessary administration role. Registration cannot create an owner."}</p>
        <label>Access decision<select name="decision"><option value="approve">Approve requested access</option><option value="reject">Reject request</option></select></label>
        {selected.audience === "admin" && <label>Approved administration role<select name="role" defaultValue="viewer">{["viewer", "editor", "business", "hr", "administrator"].map(role => <option key={role}>{role}</option>)}</select></label>}
        <label>Approval scope and policy evidence<textarea name="evidence" required minLength={10} maxLength={2000} /></label>
        <label>Owner password for this access review<input name="password" type="password" autoComplete="current-password" required maxLength={256} /></label>
        <label>Owner authenticator or recovery code for this access review<input name="code" autoComplete="one-time-code" required minLength={6} maxLength={64} /></label>
        <button className="button">{busy ? "Recording…" : "Record access decision"}</button>
      </fieldset></form>}
    </div>
  </section>;
}
