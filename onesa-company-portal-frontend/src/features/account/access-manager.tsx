"use client";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { accountRequest, productNames, type Product, type Account, type Access, type Membership, type AccountSession } from "./api";
import styles from "./account.module.css";
type ManagedAccount = { account: Account; access: Access[]; memberships: Membership[] };
type Directory = { items: ManagedAccount[]; page: number; hasMore: boolean };

export function AccessManager({ session, language }: { session: AccountSession; language: "en" | "de" }) {
  const [directory, setDirectory] = useState<Directory | null>(null), [error, setError] = useState(""), [query, setQuery] = useState(""), [busy, setBusy] = useState(false);
  const pending = useRef(false), de = language === "de";
  async function load(search = query, page = 1) {
    if (pending.current) return;
    pending.current = true; setBusy(true); setError("");
    try { setDirectory(await accountRequest<Directory>("/api/v1/admin/identity/accounts?" + new URLSearchParams({ search, page: String(page) }))); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "Unable to load accounts."); }
    finally { pending.current = false; setBusy(false); }
  }
  useEffect(() => { void load(""); /* initial directory only */ }, []);
  return <section className={styles.manager} id="access" aria-labelledby="access-title">
    <h2 id="access-title">{de ? "Konten und Produktzugänge" : "Accounts and product access"}</h2>
    <p className={styles.muted}>{de ? "Verwalten Sie Produktzugänge an einem Ort. Onesa-Administratoren verwalten alle Anwendungen; normale Konten erhalten ausdrücklich freigegebene Produkte und Arbeitsbereiche." : "Manage product access in one place. Onesa Administrators administer every application; other accounts receive explicitly approved products and workspaces."}</p>
    <form onSubmit={event => { event.preventDefault(); void load(); }}><label>{de ? "Konto suchen" : "Find an account"}<input type="search" value={query} onChange={event => setQuery(event.target.value)} maxLength={254} autoComplete="off" placeholder={de ? "E-Mail-Adresse" : "Email address"}/></label><button disabled={busy}>{busy ? (de ? "Wird geladen…" : "Loading…") : (de ? "Suchen" : "Search")}</button></form>
    {error && <p className={styles.notice} role="alert">{error}</p>}
    {directory && <><ul className={styles.people}>{directory.items.map(item => <li className={styles.person} key={item.account.id}><AccountAccessEditor item={item} session={session} language={language} onSaved={() => load(query, directory.page)}/></li>)}</ul>{directory.items.length === 0 && <p role="status">{de ? "Keine Konten gefunden." : "No accounts found."}</p>}<nav className={styles.accountLinks} aria-label={de ? "Kontoseiten" : "Account pages"}><button disabled={busy || directory.page <= 1} onClick={() => void load(query, directory.page - 1)}>{de ? "Zurück" : "Previous"}</button><span>{de ? "Seite" : "Page"} {directory.page}</span><button disabled={busy || !directory.hasMore} onClick={() => void load(query, directory.page + 1)}>{de ? "Weiter" : "Next"}</button></nav></>}
  </section>;
}
function AccountAccessEditor({ item, session, language, onSaved }: { item: ManagedAccount; session: AccountSession; language: "en" | "de"; onSaved: () => Promise<void> }) {
  const [product, setProduct] = useState<Product>(item.access.find(a => a.status === "pending")?.product ?? "ai");
  const selected = item.access.find(a => a.product === product), de = language === "de";
  const [role, setRole] = useState(selected?.role ?? (product === "ai" ? "user" : "viewer")), [status, setStatus] = useState("active");
  const [memberships, setMemberships] = useState<Membership[]>(item.memberships), [busy, setBusy] = useState(false), [notice, setNotice] = useState(""), [error, setError] = useState(false);
  const pending = useRef(false);
  function chooseProduct(value: Product) { setProduct(value); const grant = item.access.find(a => a.product === value); setRole(grant?.role ?? (value === "ai" ? "user" : "viewer")); setStatus(grant?.status === "revoked" || grant?.status === "rejected" ? grant.status : "active"); setNotice(""); }
  async function save(event: FormEvent<HTMLFormElement>, administrator?: boolean) {
    event.preventDefault(); if (pending.current) return;
    const form = event.currentTarget, data = new FormData(form);
    pending.current = true; setBusy(true); setNotice(""); setError(false);
    try {
      const stepUp = { password: String(data.get("password")), code: String(data.get("code")) };
      if (administrator !== undefined) await accountRequest("/api/v1/admin/identity/accounts/" + item.account.id + "/administrator", { administrator, stepUp }, session.csrf, "PUT");
      else await accountRequest("/api/v1/admin/identity/accounts/" + item.account.id + "/products/" + product, { role, status, expectedRevision: selected?.revision ?? 0, memberships: product === "drone" ? memberships : [], stepUp }, session.csrf, "PUT");
      form.reset(); await onSaved(); setNotice(de ? "Zugang gespeichert. Änderungen gelten bei der nächsten authentifizierten Anfrage." : "Access saved. Changes apply on the next authenticated request.");
    } catch (reason) { setError(true); setNotice(reason instanceof Error ? reason.message : "Unable to save access."); }
    finally { pending.current = false; setBusy(false); }
  }
  const confirmation = <fieldset className={styles.security}><legend>{de ? "Änderung bestätigen" : "Confirm this change"}</legend><p className={styles.muted}>{de ? "Verwenden Sie Ihr eigenes Passwort und einen neuen Authenticator- oder unbenutzten Wiederherstellungscode." : "Use your own password and a fresh authenticator or unused recovery code."}</p><label>{de ? "Ihr Passwort" : "Your password"}<input name="password" type="password" autoComplete="current-password" required maxLength={256}/></label><label>{de ? "Ihr Authenticator-Code" : "Your authenticator code"}<input name="code" autoComplete="one-time-code" required minLength={6} maxLength={64}/></label></fieldset>;
  return <details><summary><strong>{item.account.name}</strong>{item.account.email} · {item.account.globalAdmin ? (de ? "Onesa-Administrator" : "Onesa Administrator") : item.access.filter(a => a.status === "active").map(a => productNames[a.product]).join(", ") || (de ? "Noch kein Produktzugang" : "No product access yet")}</summary>
    {!item.account.emailVerified && <p className={styles.notice}>{de ? "Dieses Konto muss zuerst seine E-Mail bestätigen." : "This account must verify its email before access can be granted."}</p>}
    {item.account.globalAdmin ? <p className={styles.muted}>{de ? "Dieser Administrator hat Verwaltungszugriff auf alle Anwendungen. Ein persönlicher Produktzugang begrenzt diese globale Rolle nicht." : "This Administrator has administration access to every application. Individual product grants do not limit that global role."}</p> : <form onSubmit={event => void save(event)} aria-busy={busy}><fieldset disabled={busy || !item.account.emailVerified}><div className={styles.formGrid}>
      <label>{de ? "Produkt" : "Product"}<select value={product} onChange={event => chooseProduct(event.target.value as Product)}>{(Object.keys(productNames) as Product[]).map(value => <option value={value} key={value}>{productNames[value]}</option>)}</select></label>
      <label>{de ? "Zugang" : "Access"}<select value={status} onChange={event => setStatus(event.target.value)}><option value="active">{de ? "Freigeben" : "Approve"}</option><option value="revoked">{de ? "Entziehen" : "Revoke"}</option><option value="rejected">{de ? "Anfrage ablehnen" : "Decline request"}</option></select></label>
      <label>{de ? "Maximale Produktrolle" : "Maximum product role"}<select value={role} onChange={event => setRole(event.target.value)}>{(product === "ai" ? ["user", "admin"] : ["viewer", "operator", "admin"]).map(value => <option key={value} value={value}>{({ user: de ? "Benutzer" : "User", viewer: de ? "Lesend" : "Viewer", operator: de ? "Operator" : "Operator", admin: de ? "Produktadministrator" : "Product administrator" } as Record<string, string>)[value]}</option>)}</select></label>
      <p className={styles.muted}>{de ? "Nur Onesa-Administratoren erhalten automatisch alle Produkte." : "Only Onesa Administrators automatically receive every product."}</p>
    </div>
    {product === "drone" && <fieldset className={styles.choices}><legend>{de ? "Drone-Arbeitsbereiche" : "Drone workspaces"}</legend><p className={styles.muted}>{de ? "Wählen Sie bestehende Arbeitsbereiche. Die Kennung finden Sie in Onesa Drone; neue Konten werden keinem Kundenbereich automatisch zugeordnet. Die maximale Produktrolle begrenzt auch die Rechte in jedem Arbeitsbereich." : "Assign existing workspaces using the identifier shown in Onesa Drone. New accounts are never automatically placed in a customer workspace. The maximum product role also caps permissions in every workspace."}</p>{memberships.map((membership, index) => <div className={styles.formGrid} key={index}><label>{de ? "Name des Arbeitsbereichs" : "Workspace name"}<input value={membership.label} required maxLength={120} onChange={event => setMemberships(old => old.map((value, i) => i === index ? { ...value, label: event.target.value } : value))}/></label><label>{de ? "Arbeitsbereich-Kennung" : "Workspace identifier"}<input value={membership.tenant_id} required pattern="[a-fA-F0-9-]{36}" onChange={event => setMemberships(old => old.map((value, i) => i === index ? { ...value, tenant_id: event.target.value } : value))}/></label><label>{de ? "Rolle im Arbeitsbereich" : "Workspace role"}<select value={membership.role} onChange={event => setMemberships(old => old.map((value, i) => i === index ? { ...value, role: event.target.value as Membership["role"] } : value))}><option value="viewer">{de ? "Lesend" : "Viewer"}</option><option value="operator">Operator</option><option value="admin">{de ? "Administrator" : "Administrator"}</option></select></label><button type="button" onClick={() => setMemberships(old => old.filter((_value, i) => i !== index))}>{de ? "Arbeitsbereich entfernen" : "Remove workspace"}</button></div>)}<button type="button" disabled={memberships.length >= 50} onClick={() => setMemberships(old => [...old, { tenant_id: "", role: "viewer", label: "" }])}>{de ? "Arbeitsbereich hinzufügen" : "Add workspace"}</button></fieldset>}
    {confirmation}<button className="button">{busy ? (de ? "Wird gespeichert…" : "Saving…") : (de ? "Produktzugang speichern" : "Save product access")}</button></fieldset></form>}
    {session.account.owner && item.account.id !== session.account.id && !item.account.owner && <form onSubmit={event => void save(event, !item.account.globalAdmin)}><fieldset className={styles.security} disabled={busy || !item.account.emailVerified}><legend>{de ? "Onesa-Administratorrolle" : "Onesa Administrator role"}</legend><p className={styles.muted}>{de ? "Diese Rolle gewährt Verwaltung in allen vier Anwendungen. MFA ist erforderlich. Die Änderung beendet bestehende Sitzungen dieses Kontos." : "This role grants administration across all four applications. MFA is required. Changing it ends the account’s existing sessions."}</p>{confirmation}<button>{item.account.globalAdmin ? (de ? "Administratorrolle entfernen" : "Remove Administrator role") : (de ? "Als Onesa-Administrator ernennen" : "Make Onesa Administrator")}</button></fieldset></form>}
    {notice && <p className={styles.notice} role={error ? "alert" : "status"}>{notice}</p>}
  </details>;
}
