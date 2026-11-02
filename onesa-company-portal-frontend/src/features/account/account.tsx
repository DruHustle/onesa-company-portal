"use client";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { accessLinkToken } from "@/lib/access-link";
import { AccountError, accountRequest, productNames, type Product, type AccountSession, type Account } from "./api";
import { AccessManager } from "./access-manager";
import styles from "./account.module.css";

type Mode = "login" | "register" | "confirm";
type Interaction = { csrf: string; product: Product; freshRequired: boolean; mfaRequired: boolean; account: Account | null };
const copy = {
  en: { title: "One account. Your Onesa products.", intro: "Sign in once to access your approved products. Add another product whenever you need it.", login: "Sign in to Onesa", register: "Create your Onesa account", confirm: "Verify your email", email: "Email address", password: "Password", name: "Your name", code: "Authenticator or recovery code", wait: "Please wait…", next: "Continue", request: "Email my verification link", choose: "Choose your products", chooseHint: "Choose one, two, or all three. You can request more access later.", remember: "Remember this browser", signUp: "New to Onesa? Create one account", haveAccount: "Already registered? Sign in", applications: "Your applications", active: "Active", pending: "Awaiting approval", none: "No access yet", revoked: "Access removed", rejected: "Request not approved", open: "Open product", requestAccess: "Request access", signOut: "Sign out of Onesa", setup: "Set up your authenticator", verify: "Verify your account email", account: "Go to your account", admin: "Company administration", adminBadge: "Onesa Administrator · all applications", unavailable: "Shared sign-in is being prepared", unavailableHint: "This environment has not enabled the shared identity service yet. Your existing product sign-in remains available.", back: "Onesa home", products: { ai: "AI conversations, knowledge and intelligent workflows.", drone: "Drone operations within your approved workspaces.", robot: "Robot simulation and operations with explicit safety controls." }, sent: "Check your email for a verification link. Use your existing Onesa password if you already have an account. Product access is reviewed separately.", verified: "Your email is verified. Sign in with your Onesa account to see your product access.", requested: "Your access request is ready for an administrator to review.", confirmHint: "Choose a password of at least 14 characters for a new account. If you already have an Onesa account, enter its existing password; it will not be replaced.", continueAs: "Continue as", fresh: "Confirm your identity", freshHint: "Enter your password and authenticator code to authorize this protected action.", accessHint: "Request access from your account. You will use this same sign-in when it is approved.", passwordAgain: "Confirm password", required: "Choose at least one product.", returnProduct: "Return to your product after setup and sign in again.", retry: "Try again" },
  de: { title: "Ein Konto. Ihre Onesa-Produkte.", intro: "Einmal anmelden und Ihre freigegebenen Produkte nutzen. Weitere Produkte können Sie jederzeit hinzufügen.", login: "Bei Onesa anmelden", register: "Ihr Onesa-Konto erstellen", confirm: "E-Mail bestätigen", email: "E-Mail-Adresse", password: "Passwort", name: "Ihr Name", code: "Authenticator- oder Wiederherstellungscode", wait: "Bitte warten…", next: "Weiter", request: "Bestätigungslink senden", choose: "Ihre Produkte auswählen", chooseHint: "Wählen Sie ein, zwei oder alle drei Produkte. Weitere Zugänge können Sie später anfordern.", remember: "Diesen Browser merken", signUp: "Neu bei Onesa? Ein Konto erstellen", haveAccount: "Bereits registriert? Anmelden", applications: "Ihre Anwendungen", active: "Aktiv", pending: "Freigabe ausstehend", none: "Noch kein Zugang", revoked: "Zugang entzogen", rejected: "Anfrage nicht freigegeben", open: "Produkt öffnen", requestAccess: "Zugang anfordern", signOut: "Bei Onesa abmelden", setup: "Authenticator einrichten", verify: "Konto-E-Mail bestätigen", account: "Zu Ihrem Konto", admin: "Unternehmensverwaltung", adminBadge: "Onesa-Administrator · alle Anwendungen", unavailable: "Gemeinsame Anmeldung wird vorbereitet", unavailableHint: "Der gemeinsame Identitätsdienst ist in dieser Umgebung noch nicht aktiviert. Ihre bisherige Produktanmeldung bleibt verfügbar.", back: "Onesa-Startseite", products: { ai: "KI-Gespräche, Wissen und intelligente Arbeitsabläufe.", drone: "Drohnenbetrieb in Ihren freigegebenen Arbeitsbereichen.", robot: "Robotersimulation und Betrieb mit ausdrücklichen Sicherheitsfreigaben." }, sent: "Prüfen Sie Ihre E-Mails auf den Bestätigungslink. Verwenden Sie Ihr bisheriges Onesa-Passwort, wenn Sie bereits ein Konto haben. Produktzugänge werden gesondert freigegeben.", verified: "Ihre E-Mail ist bestätigt. Melden Sie sich mit Ihrem Onesa-Konto an, um Ihre Produktzugänge zu sehen.", requested: "Ihre Zugangsanfrage kann jetzt von einem Administrator geprüft werden.", confirmHint: "Wählen Sie für ein neues Konto ein Passwort mit mindestens 14 Zeichen. Haben Sie bereits ein Onesa-Konto, geben Sie dessen bisheriges Passwort ein; es wird nicht ersetzt.", continueAs: "Weiter als", fresh: "Identität bestätigen", freshHint: "Geben Sie Ihr Passwort und Ihren Authenticator-Code ein, um diese geschützte Aktion zu bestätigen.", accessHint: "Fordern Sie den Zugang in Ihrem Konto an. Nach der Freigabe verwenden Sie dieselbe Anmeldung.", passwordAgain: "Passwort bestätigen", required: "Wählen Sie mindestens ein Produkt.", returnProduct: "Kehren Sie nach der Einrichtung zu Ihrem Produkt zurück und melden Sie sich erneut an.", retry: "Erneut versuchen" },
};

export function OnesaAccount({ mode = "login", interactionId }: { mode?: Mode; interactionId?: string }) {
  const [language, setLanguage] = useState<"en" | "de">("en"), [session, setSession] = useState<AccountSession | null>(null);
  const [interaction, setInteraction] = useState<Interaction | null>(null), [enabled, setEnabled] = useState<boolean | null>(null), [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState(""), [error, setError] = useState(false), [busy, setBusy] = useState(false), [done, setDone] = useState(false), [factor, setFactor] = useState(false), [help, setHelp] = useState("");
  const [link, setLink] = useState<string | null>(null), [selected, setSelected] = useState<Product[]>([]);
  const pending = useRef(false), status = useRef<HTMLParagraphElement>(null), codeInput = useRef<HTMLInputElement>(null);
  const t = copy[language];
  useEffect(() => { try { if (localStorage.getItem("onesa.account.language") === "de") setLanguage("de"); } catch { /* storage is optional */ } }, []);
  useEffect(() => { if (factor) codeInput.current?.focus(); }, [factor]);
  useEffect(() => { if (done) status.current?.focus(); }, [done]);
  useEffect(() => {
    if (mode !== "confirm") return;
    const receive = () => { setLink(accessLinkToken(window.location.hash)); window.history.replaceState(null, "", window.location.pathname); };
    receive(); window.addEventListener("hashchange", receive); return () => window.removeEventListener("hashchange", receive);
  }, [mode]);
  useEffect(() => {
    let active = true;
    async function load() {
      try {
        const config = await accountRequest<{ enabled: boolean }>("/api/v1/account/config");
        if (!active) return; setEnabled(config.enabled);
        if (!config.enabled) return;
        if (interactionId) { const result = await accountRequest<Interaction>("/api/v1/account/interaction/" + encodeURIComponent(interactionId)); if (active) setInteraction(result); }
        else if (mode === "login") {
          try { const result = await accountRequest<AccountSession>("/api/v1/account/me"); if (active) setSession(result); }
          catch (reason) { if (!(reason instanceof AccountError && reason.status === 401)) throw reason; }
        }
      } catch (reason) { if (active) { setError(true); setNotice(reason instanceof Error ? reason.message : "Unable to load your account."); } }
      finally { if (active) setLoading(false); }
    }
    void load(); return () => { active = false; };
  }, [interactionId, mode]);
  function chooseLanguage(value: "en" | "de") { setLanguage(value); try { localStorage.setItem("onesa.account.language", value); } catch { /* storage is optional */ } }
  function follow(result: { continuePath: string }) {
    if (!/^\/api\/v1\/identity\/auth\/[A-Za-z0-9_-]{8,128}$/.test(result.continuePath)) throw Error("Invalid sign-in continuation.");
    window.location.assign(result.continuePath);
  }
  async function action(work: () => Promise<void>) {
    if (pending.current) return;
    pending.current = true; setBusy(true); setNotice(""); setError(false); setHelp("");
    try { await work(); }
    catch (reason) {
      setError(true); setNotice(reason instanceof Error ? reason.message : "The request could not be completed.");
      if (reason instanceof AccountError) {
        if (reason.code === "MFA_REQUIRED") setFactor(true);
        if (["MFA_ENROLLMENT_REQUIRED", "EMAIL_VERIFICATION_REQUIRED", "PRODUCT_ACCESS_REQUIRED"].includes(reason.code)) setHelp(reason.code);
      }
    } finally { pending.current = false; setBusy(false); }
  }
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const data = new FormData(event.currentTarget);
    await action(async () => {
      if (mode === "register") {
        if (!selected.length) throw Error(t.required);
        await accountRequest("/api/v1/account/register", { email: String(data.get("email")).trim().toLowerCase(), name: String(data.get("name")).trim(), products: selected });
        setDone(true); setNotice(t.sent); return;
      }
      if (mode === "confirm") {
        if (!link) throw Error("Open your latest verification link or request a new one.");
        if (data.get("password") !== data.get("confirmPassword")) throw Error(language === "de" ? "Die Passwörter müssen übereinstimmen." : "The passwords must match.");
        await accountRequest("/api/v1/account/confirm", { token: link, password: String(data.get("password")) });
        setLink(null); setDone(true); setNotice(t.verified); return;
      }
      const body = { email: String(data.get("email")).trim().toLowerCase(), password: String(data.get("password")), code: String(data.get("code") || ""), rememberBrowser: data.get("remember") === "on" };
      if (interactionId && interaction) follow(await accountRequest("/api/v1/account/interaction/" + encodeURIComponent(interactionId) + "/login", { ...body, csrf: interaction.csrf }));
      else {
        const result = await accountRequest<AccountSession>("/api/v1/account/login", body); setSession(result);
        if (new URLSearchParams(window.location.search).get("next") === "/admin" && result.account.portalAccess) window.location.assign("/admin");
      }
    });
  }
  const setupUrl = "/account/setup-authenticator" + (interactionId ? "?returnTo=" + encodeURIComponent("/account/sign-in/" + interactionId) : "");
  const noticeElement = notice && <p className={styles.notice} role={error ? "alert" : "status"} ref={status} tabIndex={-1}>{notice}</p>;
  return <main className={styles.shell} lang={language}>
    <header className={styles.header}><a className={styles.brand} href="/account" aria-label="Onesa account">onesa<span>ACCOUNT</span></a><label><span className={styles.srOnly}>Language / Sprache</span><select aria-label="Language / Sprache" value={language} onChange={event => chooseLanguage(event.target.value as "en" | "de")}><option value="en">English</option><option value="de">Deutsch</option></select></label></header>
    {loading ? <section className={styles.card}><p role="status">{t.wait}</p></section> : enabled === false ? <section className={styles.card}><h1>{t.unavailable}</h1><p className={styles.muted}>{t.unavailableHint}</p><a href="/en">{t.back}</a></section> : session ? <div className={styles.workspace}>
      <div className={styles.toolbar}><p><strong>{session.account.name}</strong><br/><span className={styles.muted}>{session.account.email}</span></p><button className={styles.action} disabled={busy} onClick={() => void action(async () => { await accountRequest("/api/v1/account/logout", {}, session.csrf); setSession(null); })}>{t.signOut}</button></div>
      <section className={styles.intro}><h1>{t.applications}</h1><p>{t.intro}</p>{session.account.globalAdmin && <span className={styles.badge}>{t.adminBadge}</span>}</section>
      {noticeElement}
      <section className={styles.grid} aria-label={t.applications}>{(Object.keys(productNames) as Product[]).map(product => {
        const grant = session.access.find(item => item.product === product), active = session.account.globalAdmin || grant?.status === "active";
        const application = session.applications.find(item => item.product === product);
        return <article className={styles.product} key={product}><span className={styles.badge}>{active ? t.active : grant ? t[grant.status] : t.none}</span><h2>{productNames[product]}</h2><p>{t.products[product]}</p>
          {active && application ? <a className={"button " + styles.action} href={application.url}>{t.open}</a> : <button className={styles.action} disabled={busy || grant?.status === "pending" || active} onClick={() => void action(async () => { setSession(await accountRequest<AccountSession>("/api/v1/account/products/" + product + "/request", {}, session.csrf)); setNotice(t.requested); })}>{grant?.status === "pending" ? t.pending : active ? t.unavailable : t.requestAccess}</button>}
        </article>;
      })}</section>
      <nav className={styles.accountLinks} aria-label={language === "de" ? "Kontoeinstellungen" : "Account settings"}>{session.account.portalAccess && <a className={styles.action} href="/admin">{t.admin}</a>}{!session.account.mfaEnrolled && <a className={styles.action} href={setupUrl}>{t.setup}</a>}<a className={styles.action} href="/account/security">{language === "de" ? "Passwort und Sicherheit" : "Password and security"}</a></nav>
      {session.account.globalAdmin && <AccessManager session={session} language={language} />}
    </div> : <section className={styles.card} aria-labelledby="account-title">
      <h1 id="account-title">{mode === "register" ? t.register : mode === "confirm" ? t.confirm : interaction?.freshRequired ? t.fresh : t.login}</h1>
      <p className={styles.muted}>{mode === "register" ? t.chooseHint : mode === "confirm" ? t.confirmHint : interaction?.freshRequired ? t.freshHint : interaction ? productNames[interaction.product] : t.intro}</p>
      {interaction?.account && !interaction.freshRequired && !done && <><button className={"button " + styles.action} disabled={busy} onClick={() => void action(async () => follow(await accountRequest("/api/v1/account/interaction/" + encodeURIComponent(interactionId!) + "/continue", { csrf: interaction.csrf })))}>{t.continueAs} {interaction.account.email}</button><p className={styles.muted}>{language === "de" ? "Oder mit einem anderen Konto anmelden:" : "Or sign in with another account:"}</p></>}
      {!done && <form onSubmit={submit} aria-busy={busy}><fieldset disabled={busy || enabled !== true || (Boolean(interactionId) && !interaction) || (mode === "confirm" && !link)}><legend className={styles.srOnly}>{t.login}</legend>
        {mode === "register" && <label>{t.name}<input name="name" autoComplete="name" required maxLength={200}/></label>}
        {mode !== "confirm" && <label>{t.email}<input name="email" type="email" autoComplete="username" required maxLength={254} defaultValue={interaction?.account?.email || ""}/></label>}
        {mode !== "register" && <label>{t.password}<input name="password" type="password" autoComplete={mode === "confirm" ? "new-password" : "current-password"} required maxLength={256}/></label>}
        {mode === "confirm" && <label>{t.passwordAgain}<input name="confirmPassword" type="password" autoComplete="new-password" required maxLength={256}/></label>}
        {mode === "login" && (factor || interaction?.mfaRequired || interaction?.freshRequired) && <label>{t.code}<input ref={codeInput} name="code" autoComplete="one-time-code" required minLength={6} maxLength={64}/></label>}
        {mode === "register" && <fieldset className={styles.choices}><legend>{t.choose}</legend>{(Object.keys(productNames) as Product[]).map(product => <label className={styles.check} key={product}><input type="checkbox" checked={selected.includes(product)} onChange={event => setSelected(old => event.target.checked ? [...old, product] : old.filter(item => item !== product))}/><span>{productNames[product]}</span></label>)}</fieldset>}
        {mode === "login" && <label className={styles.check}><input name="remember" type="checkbox"/><span>{t.remember}</span></label>}
        <button className="button">{busy ? t.wait : mode === "register" ? t.request : mode === "confirm" ? t.confirm : t.next}</button>
      </fieldset></form>}
      {noticeElement}
      {help === "MFA_ENROLLMENT_REQUIRED" && <p><a href={setupUrl}>{t.setup}</a></p>}
      {help === "EMAIL_VERIFICATION_REQUIRED" && <p><a href="/account/register">{t.verify}</a></p>}
      {help === "PRODUCT_ACCESS_REQUIRED" && <p>{t.accessHint} <a href="/account">{t.account}</a></p>}
      <nav className={styles.support} aria-label="Account help"><a href={mode === "login" ? "/account/register" : "/account"}>{mode === "login" ? t.signUp : t.haveAccount}</a>{mode === "login" && <a href="/account/security">{language === "de" ? "Passwort vergessen?" : "Forgot your password?"}</a>}<a href="/en">{t.back}</a></nav>
    </section>}
  </main>;
}
