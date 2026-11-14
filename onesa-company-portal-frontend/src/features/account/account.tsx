"use client";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { accountApplicationUrl } from "@/lib/onesa-identity";
import { accessLinkToken, sharedSignInToken } from "@/lib/access-link";
import { adminWorkspaceReturn, accountDestination, accountReturnPath, accountReauthenticationRequired, docsAccountPath, productAccountPath } from "@/lib/account-return";
import { AccountError, accountRequest, productNames, adminProductNames, type ApplicationProduct, futureProductNames, enabledProducts, type Product, type ProductCatalog, type AccountConfig, type AccountSession, type Account } from "./api";
import { AdminSignIn } from "@/features/admin/sign-in";
import { AccessManager } from "./access-manager";
import styles from "./account.module.css";

type Mode = "login" | "register" | "confirm";
type Interaction = { csrf: string; product: ApplicationProduct; freshRequired: boolean; mfaRequired: boolean; account: Account | null };
const copy = {
  en: { title: "One account. Your Onesa products.", intro: "Sign in once to access your approved products. Add another product whenever you need it.", login: "Sign in to Onesa", register: "Create your Onesa account", confirm: "Verify your email", email: "Email address", password: "Password", name: "Your name", code: "Authenticator or recovery code", wait: "Please wait…", next: "Continue", request: "Email my verification link", choose: "Choose your products", chooseHint: "Choose the connected products you need. You can request more access later.", remember: "Remember this browser", signUp: "New to Onesa? Create one account", haveAccount: "Already registered? Sign in", applications: "Your applications", active: "Active", pending: "Awaiting approval", none: "No access yet", revoked: "Access removed", rejected: "Request not approved", open: "Open product", requestAccess: "Request access", signOut: "Sign out of Onesa", setup: "Set up your authenticator", verify: "Verify your account email", account: "Go to your account", admin: "Company administration", adminBadge: "Onesa Administrator", unavailable: "Onesa Account is temporarily unavailable", unavailableHint: "Use your Company Portal account for all Onesa products. Try again here to continue.", back: "Onesa home", products: { factory: "Your assigned factory assets and operational views.", logistics: "Shipments, warehouse operations and delivery records.", pasofi: "Wi-Fi plans, purchases and hotspot access.", farmer: "Your farms, equipment, livestock and field records.", ai: "AI conversations, knowledge and intelligent workflows.", drone: "Drone operations within your approved workspaces.", robot: "Robot simulation and operations with explicit safety controls.", mobile: "Mobile account, support and approved connectivity services." }, sent: "Check your email for a verification link. Use your existing Onesa password if you already have an account. Product access is reviewed separately.", verified: "Your email is verified. Sign in with your Onesa account to see your product access.", requested: "Your access request is ready for an administrator to review.", confirmHint: "Choose a password of at least 14 characters for a new account. If you already have an Onesa account, enter its existing password; it will not be replaced.", continueAs: "Continue as", fresh: "Confirm your identity", freshHint: "Enter your password and authenticator code to authorize this protected action.", accessHint: "Request access from your account. You will use this same sign-in when it is approved.", passwordAgain: "Confirm password", required: "Choose at least one product.", returnProduct: "Return to your product after setup and sign in again.", retry: "Try again", unconnected: "Not connected", futureProducts: "More Onesa products", futureHint: "Shared sign-in will be available when this product is connected to Onesa.", returnDocs: "Continue to Engineering Docs" },
  de: { title: "Ein Konto. Ihre Onesa-Produkte.", intro: "Einmal anmelden und Ihre freigegebenen Produkte nutzen. Weitere Produkte können Sie jederzeit hinzufügen.", login: "Bei Onesa anmelden", register: "Ihr Onesa-Konto erstellen", confirm: "E-Mail bestätigen", email: "E-Mail-Adresse", password: "Passwort", name: "Ihr Name", code: "Authenticator- oder Wiederherstellungscode", wait: "Bitte warten…", next: "Weiter", request: "Bestätigungslink senden", choose: "Ihre Produkte auswählen", chooseHint: "Wählen Sie die verbundenen Produkte aus, die Sie benötigen. Weitere Zugänge können Sie später anfordern.", remember: "Diesen Browser merken", signUp: "Neu bei Onesa? Ein Konto erstellen", haveAccount: "Bereits registriert? Anmelden", applications: "Ihre Anwendungen", active: "Aktiv", pending: "Freigabe ausstehend", none: "Noch kein Zugang", revoked: "Zugang entzogen", rejected: "Anfrage nicht freigegeben", open: "Produkt öffnen", requestAccess: "Zugang anfordern", signOut: "Bei Onesa abmelden", setup: "Authenticator einrichten", verify: "Konto-E-Mail bestätigen", account: "Zu Ihrem Konto", admin: "Unternehmensverwaltung", adminBadge: "Onesa-Administrator", unavailable: "Das Onesa-Konto ist vorübergehend nicht verfügbar", unavailableHint: "Ihr Konto im Unternehmensportal gilt für alle Onesa-Produkte. Versuchen Sie es hier erneut.", back: "Onesa-Startseite", products: { factory: "Ihre zugewiesenen Anlagen und Betriebsansichten.", logistics: "Sendungen, Lagerbetrieb und Liefernachweise.", pasofi: "WLAN-Tarife, Käufe und Hotspot-Zugang.", farmer: "Ihre Betriebe, Geräte, Tiere und Feldaufzeichnungen.", ai: "KI-Gespräche, Wissen und intelligente Arbeitsabläufe.", drone: "Drohnenbetrieb in Ihren freigegebenen Arbeitsbereichen.", robot: "Robotersimulation und Betrieb mit ausdrücklichen Sicherheitsfreigaben.", mobile: "Mobilfunkkonto, Support und freigegebene Verbindungsdienste." }, sent: "Prüfen Sie Ihre E-Mails auf den Bestätigungslink. Verwenden Sie Ihr bisheriges Onesa-Passwort, wenn Sie bereits ein Konto haben. Produktzugänge werden gesondert freigegeben.", verified: "Ihre E-Mail ist bestätigt. Melden Sie sich mit Ihrem Onesa-Konto an, um Ihre Produktzugänge zu sehen.", requested: "Ihre Zugangsanfrage kann jetzt von einem Administrator geprüft werden.", confirmHint: "Wählen Sie für ein neues Konto ein Passwort mit mindestens 14 Zeichen. Haben Sie bereits ein Onesa-Konto, geben Sie dessen bisheriges Passwort ein; es wird nicht ersetzt.", continueAs: "Weiter als", fresh: "Identität bestätigen", freshHint: "Geben Sie Ihr Passwort und Ihren Authenticator-Code ein, um diese geschützte Aktion zu bestätigen.", accessHint: "Fordern Sie den Zugang in Ihrem Konto an. Nach der Freigabe verwenden Sie dieselbe Anmeldung.", passwordAgain: "Passwort bestätigen", required: "Wählen Sie mindestens ein Produkt.", returnProduct: "Kehren Sie nach der Einrichtung zu Ihrem Produkt zurück und melden Sie sich erneut an.", retry: "Erneut versuchen", unconnected: "Noch nicht verbunden", futureProducts: "Weitere Onesa-Produkte", futureHint: "Die gemeinsame Anmeldung wird verfügbar, sobald dieses Produkt mit Onesa verbunden ist.", returnDocs: "Weiter zu Engineering Docs" },
};

type EntryProps = {
  mode?: Mode;
  interactionId?: string;
  docsInteractionId?: string;
  docsInteractionCsrf?: string;
  forceLogin?: boolean;
  adminEntry?: boolean;
  accessEnabled?: boolean;
  legacyAdmin?: boolean;
  legacyDocsRegistration?: boolean;
  approvalConfirmation?: boolean;
};

export function OnesaAccount({ mode = "login", interactionId, docsInteractionId, docsInteractionCsrf, forceLogin, adminEntry, accessEnabled, legacyAdmin, legacyDocsRegistration, approvalConfirmation }: EntryProps) {
  const [language, setLanguage] = useState<"en" | "de">("en"), [session, setSession] = useState<AccountSession | null>(null);
  const [interaction, setInteraction] = useState<Interaction | null>(null), [enabled, setEnabled] = useState<boolean | null>(null), [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState(""), [error, setError] = useState(false), [busy, setBusy] = useState(false), [done, setDone] = useState(false), [factor, setFactor] = useState(false), [help, setHelp] = useState("");
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [loadFailed, setLoadFailed] = useState(false);
  const [link, setLink] = useState<string | null>(null), [selected, setSelected] = useState<Product[]>([]);
  const [catalog, setCatalog] = useState<ProductCatalog | undefined>(undefined), [returnTo, setReturnTo] = useState<string | null>(null);
  const pending = useRef(false), status = useRef<HTMLParagraphElement>(null), codeInput = useRef<HTMLInputElement>(null);
  const t = copy[language];
  const [destination, setDestination] = useState(interactionId ? productAccountPath(interactionId) ?? "/account" : "/account");
  const [emailLink, setEmailLink] = useState(false), [adminToken, setAdminToken] = useState<string | null>(null);
  const explicitEmailProof = useRef(false);
  const [sharedToken,setSharedToken] = useState<string | null>(null);
  const [linkRequested,setLinkRequested] = useState(false);
  const [adminWorkspace, setAdminWorkspace] = useState("/admin");
  const [approvedAdmin, setApprovedAdmin] = useState(false);
  const approvalRequest = mode === "register" && Boolean(adminEntry || legacyDocsRegistration);
  const destinationSearch = destination.includes("?") ? destination.slice(destination.indexOf("?")) : "";
  const signupUrl = adminEntry && !legacyAdmin ? "/account/register" : "/account/register" + destinationSearch;
  useEffect(() => {
    if (adminEntry) setAdminWorkspace(adminWorkspaceReturn(window.location.hash));
    let target = interactionId ? productAccountPath(interactionId) ?? "/account" : accountDestination(window.location.search);
    if (mode === "confirm" && target === "/account") {
      try {
        const stored = JSON.parse(sessionStorage.getItem("onesa.account.registrationReturn") || "null");
        if (stored && Number.isFinite(stored.until) && stored.until > Date.now() && typeof stored.search === "string") target = accountDestination(stored.search);
      } catch { /* Return to account when this tab has no valid pending registration. */ }
    }
    setDestination(target);
    if (mode !== "login") return;
    const receive = () => {
      const shared = sharedSignInToken(window.location.hash);
      if (!legacyAdmin && shared) {
        explicitEmailProof.current = true;
        setSession(null); setSharedToken(shared); setEmailLink(true); setFactor(false);
        window.history.replaceState(null,"",window.location.pathname + window.location.search);
        return;
      }
      if (!adminEntry || !accessEnabled) return;
      const raw = accessLinkToken(window.location.hash);
      if (raw) { setAdminToken(raw); setEmailLink(true); window.history.replaceState(null, "", window.location.pathname + window.location.search); }
    };
    receive(); window.addEventListener("hashchange", receive); return () => window.removeEventListener("hashchange", receive);
  }, [adminEntry, accessEnabled, mode, interactionId, legacyAdmin]);
  const [products, setProducts] = useState<Product[]>([]);
  useEffect(() => { setReturnTo(accountReturnPath(window.location.search)); try { if (localStorage.getItem("onesa.account.language") === "de") setLanguage("de"); } catch { /* storage is optional */ } }, []);
  useEffect(() => { if (factor) codeInput.current?.focus(); }, [factor]);
  useEffect(() => { if (done) status.current?.focus(); }, [done]);
  useEffect(() => {
    if (mode !== "confirm") return;
    const receive = () => {
      const proof = accessLinkToken(window.location.hash);
      if (!proof) return;
      setLink(proof); setDone(false); setNotice(""); setError(false); setApprovedAdmin(false);
      window.history.replaceState(null, "", window.location.pathname + window.location.search);
    };
    receive(); window.addEventListener("hashchange", receive); return () => window.removeEventListener("hashchange", receive);
  }, [mode]);
  useEffect(() => {
    let active = true;
    async function load() {
      setLoading(true);
      setLoadFailed(false);
      try {
        if (legacyAdmin || approvalConfirmation || approvalRequest) { setEnabled(approvalConfirmation || Boolean(accessEnabled) || Boolean(legacyAdmin)); return; }
        let config: AccountConfig;
        try { config = await accountRequest<AccountConfig>("/api/v1/account/config"); }
        catch { if (active) setLoadFailed(true); return; }
        if (!active) return; setEnabled(config.enabled); setCatalog(config.catalog); setProducts(enabledProducts(config.applications ?? []));
        if (!config.enabled) return;
        if (interactionId) { const result = await accountRequest<Interaction>("/api/v1/account/interaction/" + encodeURIComponent(interactionId)); if (active) setInteraction(result); }
        else if (mode === "login" && !adminEntry && !forceLogin && !explicitEmailProof.current && !accountReauthenticationRequired(window.location.search)) {
          try { const result = await accountRequest<AccountSession>("/api/v1/account/me"); if (active && !explicitEmailProof.current) {
            if (accountDestination(window.location.search) === "/account?next=/engineering") window.location.replace("/engineering");
            else setSession(result);
          } }
          catch (reason) { if (!(reason instanceof AccountError && reason.status === 401)) throw reason; }
        }
      } catch (reason) { if (active) { setError(true); setNotice(reason instanceof Error ? reason.message : "Unable to load your account."); } }
      finally { if (active) setLoading(false); }
    }
    void load(); return () => { active = false; };
  }, [interactionId, mode, forceLogin, adminEntry, accessEnabled, legacyAdmin, approvalRequest, approvalConfirmation, loadAttempt]);
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
    event.preventDefault();
    if (loading || loadFailed || enabled !== true || (interactionId && !interaction)) return;
    const data = new FormData(event.currentTarget);
    await action(async () => {
      if (mode === "register") {
        const email = String(data.get("email")).trim().toLowerCase(), name = String(data.get("name")).trim();
        if (approvalRequest) await accountRequest("/api/v1/access/register", { email, name: name.slice(0, 120), audience: adminEntry ? "admin" : "engineering" });
        else await accountRequest("/api/v1/account/register", { email, name, products: selected });
        try { sessionStorage.setItem("onesa.account.registrationReturn", JSON.stringify({ search: destinationSearch, until: Date.now() + 15 * 60 * 1000 })); } catch { /* The initiating tab remains available without storage. */ }
        setDone(true); setNotice(t.sent); return;
      }
      if (mode === "confirm") {
        if (!link) throw Error("Open your latest verification link or request a new one.");
        if (data.get("password") !== data.get("confirmPassword")) throw Error(language === "de" ? "Die Passwörter müssen übereinstimmen." : "The passwords must match.");
        const body = {token: link, password: String(data.get("password"))};
        if (approvalConfirmation) {
          const result = await accountRequest<{audience: string; status: string}>("/api/v1/access/confirm", body);
          setApprovedAdmin(result.status === "approved" && result.audience === "admin");
          setDestination(result.audience === "admin" ? "/account?next=/admin" : destination === "/account" ? "/account?next=/engineering" : destination);
          setNotice(result.status === "approved" ? "Your email is verified and your existing approval is recognized." + (result.audience === "admin" ? " New administrators must enroll their authenticator before signing in." : " You can now sign in to Engineering Docs.") : "Your email is verified. Your request has been sent to the owner for approval. We will email you the decision.");
        } else {
          await accountRequest("/api/v1/account/confirm", body);
          setNotice(destination === "/account" ? t.verified + " " + (language === "de"
            ? "Wenn Sie in einer Anwendung begonnen haben, kehren Sie zum ursprünglichen Tab zurück und wählen Sie „Bereits registriert? Anmelden“."
            : "If you started in an application, return to the original tab and choose “Already registered? Sign in”.") : t.verified);
        }
        try { sessionStorage.removeItem("onesa.account.registrationReturn"); } catch { /* Optional storage. */ }
        setLink(null); setDone(true); return;
      }
      const email = String(data.get("email")).trim().toLowerCase();
      if (emailLink && !sharedToken) {
        if (docsInteractionId && docsInteractionCsrf)
          await accountRequest("/engineering/sign-in/" + encodeURIComponent(docsInteractionId) + "/account-email-link", {email, csrf: docsInteractionCsrf});
        else if (interactionId && interaction)
          await accountRequest("/api/v1/account/interaction/" + encodeURIComponent(interactionId) + "/email-link", {email, csrf: interaction.csrf});
        else await accountRequest("/api/v1/account/email-link", adminEntry ? { email, returnTo: "/admin" } : { email });
        setLinkRequested(true);
        setNotice(language === "de" ? "Wenn dein Konto berechtigt ist, erhältst du einen Anmeldelink. Er ist 15 Minuten gültig." : "If your account is eligible, we will email a sign-in link valid for 15 minutes.");
        return;
      }
      const body = { email, ...(emailLink && sharedToken ? {emailToken:sharedToken} : {password:String(data.get("password"))}),
        code:String(data.get("code") || ""),rememberBrowser:data.get("remember") === "on" };
      if (docsInteractionId && docsInteractionCsrf && emailLink && sharedToken) {
        await accountRequest("/engineering/sign-in/" + encodeURIComponent(docsInteractionId) + "/account-email-login", {...body, csrf: docsInteractionCsrf});
        window.location.replace(docsAccountPath(docsInteractionId)!); return;
      }
      if (interactionId && interaction) follow(await accountRequest("/api/v1/account/interaction/" + encodeURIComponent(interactionId) + "/login", { ...body, csrf: interaction.csrf }));
      else {
        const result = await accountRequest<AccountSession>("/api/v1/account/login", body);
        if (docsInteractionId) { window.location.replace(docsAccountPath(docsInteractionId)!); return; }
        if (accountDestination(window.location.search) === "/account?next=/engineering") { window.location.assign("/engineering"); return; }
        const destination = accountReturnPath(window.location.search);
        if (destination) window.location.assign(destination);
        else if (new URLSearchParams(window.location.search).get("next") === "/account/delete") window.location.assign("/account/delete");
        else if (new URLSearchParams(window.location.search).get("next") === "/admin" && result.account.portalAccess) window.location.assign(adminWorkspace);
        else {
          setSharedToken(null);
          setEmailLink(false);
          setSession(result);
        }
      }
    });
  }
  const setupReturn = docsInteractionId ? "/engineering/sign-in/" + docsInteractionId : interactionId ? "/account/sign-in/" + interactionId : adminEntry ? "/admin" : returnTo;
  const setupUrl = "/account/setup-authenticator" + (setupReturn ? "?returnTo=" + encodeURIComponent(setupReturn) : "");
  const available = session?.catalog ?? catalog;
  const connected = (product: Product) => available === undefined || available.some(item => item.product === product && item.connected === true);
  const adminApplications = session?.account.globalAdmin
    ? session.applications.filter((app): app is { product: keyof typeof adminProductNames; url: string } => Object.prototype.hasOwnProperty.call(adminProductNames, app.product))
    : [];
  const futureProducts = <section className={styles.grid} aria-label={t.futureProducts}>{Object.entries(futureProductNames).filter(([product]) => !products.includes(product as Product) && !available?.some(item => item.product === product && item.connected)).map(([product, name]) => <article className={styles.product} key={product}><span className={styles.badge}>{t.unconnected}</span><h2>{available?.find(item => item.product === product)?.name || name}</h2><p>{t.futureHint}</p></article>)}</section>;
  const noticeElement = notice && <p className={styles.notice} role={error ? "alert" : "status"} ref={status} tabIndex={-1}>{notice}</p>;
  return <main className={styles.shell} lang={language}>
    <header className={styles.header}><a className={styles.brand} href="/account" aria-label="Onesa account">onesa<span>ACCOUNT</span></a><label><span className={styles.srOnly}>Language / Sprache</span><select aria-label="Language / Sprache" value={language} onChange={event => chooseLanguage(event.target.value as "en" | "de")}><option value="en">English</option><option value="de">Deutsch</option></select></label></header>
    {loading ? <section className={styles.card}><p role="status">{t.wait}</p></section> : loadFailed || enabled === false ? <section className={styles.card}>
      <h1>{t.unavailable}</h1><p className={styles.muted}>{t.unavailableHint}</p>
      <button type="button" className={styles.action} onClick={() => setLoadAttempt(attempt => attempt + 1)}>{t.retry}</button>
      <a href="/en">{t.back}</a>
    </section> : session && !emailLink ? <div className={styles.workspace}>
      <div className={styles.toolbar}><p><strong>{session.account.name}</strong><br/><span className={styles.muted}>{session.account.email}</span></p><button className={styles.action} disabled={busy} onClick={() => void action(async () => { await accountRequest("/api/v1/account/logout", {}, session.csrf); setSession(null); })}>{t.signOut}</button></div>
      <section className={styles.intro}><h1>{t.applications}</h1><p>{t.intro}</p>{session.account.globalAdmin && <span className={styles.badge}>{t.adminBadge}</span>}</section>
      {docsInteractionId && <p role="status">{language === "de" ? "Für dieses Konto ist kein Zugang zu Engineering Docs verfügbar." : "Engineering Docs access is unavailable for this account."} <a href={docsAccountPath(docsInteractionId) + "&reauthenticate=1"}>{language === "de" ? "Mit einem anderen Konto anmelden" : "Use another account"}</a></p>}
      {adminEntry && !session.account.portalAccess && <p>{language === "de" ? "Der Inhaber muss den Administratorzugang freigeben." : "Administrator access requires owner approval."} <a href="/account/register?next=/admin">{language === "de" ? "Administratorzugang anfordern" : "Request administrator access"}</a></p>}
      {returnTo && <p><a className={"button " + styles.action} href={returnTo}>{t.returnDocs}</a></p>}
      {noticeElement}
      <section className={styles.grid} aria-label={t.applications}>{products.map(product => {
        const grant = session.access.find(item => item.product === product), active = session.account.globalAdmin || grant?.status === "active" || (product === "farmer" && !grant && session.account.portalAccess && session.account.emailVerified), isConnected = connected(product);
        const application = session.applications.find(item => item.product === product);
        return <article className={styles.product} key={product}><span className={styles.badge}>{!isConnected ? t.unconnected : active ? t.active : grant ? t[grant.status] : t.none}</span><h2>{productNames[product]}</h2><p>{t.products[product]}</p>
          {!isConnected ? <p>{t.futureHint}</p> : active && application ? <a className={"button " + styles.action} href={accountApplicationUrl(product, application.url, session.account.globalAdmin)}>{t.open}</a> : <button className={styles.action} disabled={busy || grant?.status === "pending" || active} onClick={() => void action(async () => { setSession(await accountRequest<AccountSession>("/api/v1/account/products/" + product + "/request", {}, session.csrf)); setNotice(t.requested); })}>{grant?.status === "pending" ? t.pending : active ? t.unavailable : t.requestAccess}</button>}
        </article>;
      })}{adminApplications.map(app => <article className={styles.product} key={app.product}>
        <span className={styles.badge}>{t.adminBadge}</span><h2>{adminProductNames[app.product]}</h2>
        <a className={"button " + styles.action} href={accountApplicationUrl(app.product, app.url, session.account.globalAdmin)}>{t.open}</a>
      </article>)}</section>
      <h2>{t.futureProducts}</h2>{futureProducts}
      <nav className={styles.accountLinks} aria-label={language === "de" ? "Kontoeinstellungen" : "Account settings"}>{session.account.portalAccess && <a className={styles.action} href={adminWorkspace}>{t.admin}</a>}<a className={styles.action} href="/engineering">Engineering Docs</a>{!session.account.mfaEnrolled && <a className={styles.action} href={setupUrl}>{t.setup}</a>}<a className={styles.action} href="/account/billing">{language === "de" ? "Abrechnung" : "Billing"}</a><a className={styles.action} href="/account/security">{language === "de" ? "Passwort und Sicherheit" : "Password and security"}</a><a className={styles.action} href="/account/delete">{language === "de" ? "Kontolöschung beantragen" : "Request account deletion"}</a></nav>
      {session.account.globalAdmin && <AccessManager session={session} language={language} />}
    </div> : <section className={styles.card} aria-labelledby="account-title">
      <h1 id="account-title">{mode === "register" ? t.register : mode === "confirm" ? t.confirm : interaction?.freshRequired ? t.fresh : t.login}</h1>
      <p className={styles.muted}>{mode === "register" ? (approvalRequest ? (language === "de" ? "Der Inhaber prüft Ihren Zugang nach der E-Mail-Bestätigung." : "The owner reviews your access request after you verify your email.") : t.chooseHint) : mode === "confirm" ? t.confirmHint : interaction?.freshRequired ? t.freshHint : interaction ? { ...productNames, ...adminProductNames }[interaction.product] : t.intro}</p>
      {interaction?.account && !interaction.freshRequired && !done && <><button className={"button " + styles.action} disabled={busy} onClick={() => void action(async () => follow(await accountRequest("/api/v1/account/interaction/" + encodeURIComponent(interactionId!) + "/continue", { csrf: interaction.csrf })))}>{t.continueAs} {interaction.account.email}</button><p className={styles.muted}>{language === "de" ? "Oder mit einem anderen Konto anmelden:" : "Or sign in with another account:"}</p></>}
      {mode === "login" && !legacyAdmin && !adminToken && <div role="group" className={styles.support} aria-label={language === "de" ? "Anmeldemethode" : "Sign-in method"}>
        <button type="button" className={styles.action} aria-pressed={!emailLink} onClick={() => { setEmailLink(false); setAdminToken(null); setSharedToken(null); setLinkRequested(false); setFactor(false); setNotice(""); }}>{language === "de" ? "E-Mail und Passwort" : "Email and password"}</button>
        <button type="button" className={styles.action} aria-pressed={emailLink} onClick={() => { setEmailLink(true); setFactor(false); setNotice(""); }}>{language === "de" ? "Anmeldelink per E-Mail" : "Email a sign-in link"}</button>
      </div>}
      {mode === "login" && adminEntry && (legacyAdmin || adminToken) ? <AdminSignIn accessEnabled={Boolean(accessEnabled)} linkOnly={!legacyAdmin || Boolean(adminToken)} initialToken={adminToken} onSignedIn={() => window.location.replace(adminWorkspace)}/> :
      !done && <form onSubmit={submit} aria-busy={busy}><fieldset disabled={busy || enabled !== true || (Boolean(interactionId) && !interaction) || (mode === "confirm" && !link)}><legend className={styles.srOnly}>{t.login}</legend>
        {mode === "register" && <label>{t.name}<input name="name" autoComplete="name" required maxLength={approvalRequest ? 120 : 200}/></label>}
        {mode !== "confirm" && <label>{t.email}<input name="email" type="email" autoComplete="username" required maxLength={254} defaultValue={interaction?.account?.email || ""}/></label>}
        {mode !== "register" && !emailLink && <label>{t.password}<input name="password" type="password" autoComplete={mode === "confirm" ? "new-password" : "current-password"} minLength={mode === "confirm" ? 14 : undefined} required maxLength={256}/></label>}
        {mode === "confirm" && <label>{t.passwordAgain}<input name="confirmPassword" type="password" autoComplete="new-password" required maxLength={256}/></label>}
        {mode === "login" && (!emailLink || sharedToken) && (factor || interaction?.mfaRequired || interaction?.freshRequired) && <label>{t.code}<input ref={codeInput} name="code" autoComplete="one-time-code" required minLength={6} maxLength={64}/></label>}
        {mode === "register" && !approvalRequest && <fieldset className={styles.choices}><legend>{t.choose}</legend>{products.map(product => <label className={styles.check} key={product}><input type="checkbox" disabled={!connected(product)} checked={selected.includes(product)} onChange={event => setSelected(old => event.target.checked ? [...old, product] : old.filter(item => item !== product))}/><span>{productNames[product]}{!connected(product) && <> · {t.unconnected}</>}</span></label>)}</fieldset>}
        {mode === "login" && (!emailLink || sharedToken) && <label className={styles.check}><input name="remember" type="checkbox"/><span>{t.remember}</span></label>}
        <button className="button">{busy ? t.wait : emailLink ? (sharedToken ? (language === "de" ? "Anmeldung bestätigen" : "Confirm sign-in") : (linkRequested ? (language === "de" ? "Link erneut anfordern" : "Request another link") : (language === "de" ? "Anmeldelink senden" : "Send sign-in link"))) : mode === "register" ? t.request : mode === "confirm" ? t.confirm : t.next}</button>
      </fieldset></form>}
      {interactionId && interaction && <button className={styles.action} type="button" disabled={busy}
        onClick={() => void action(async () => follow(await accountRequest("/api/v1/account/interaction/" + encodeURIComponent(interactionId) + "/cancel", {csrf: interaction.csrf})))}>
        {language === "de" ? "Anmeldung abbrechen" : "Cancel sign-in"}
      </button>}
      {noticeElement}
      {approvedAdmin && <p><a href="/access/setup-authenticator">{t.setup}</a></p>}
      {help === "MFA_ENROLLMENT_REQUIRED" && <p><a href={setupUrl}>{t.setup}</a></p>}
      {help === "EMAIL_VERIFICATION_REQUIRED" && <p><a href={signupUrl}>{t.verify}</a></p>}
      {help === "PRODUCT_ACCESS_REQUIRED" && <p>{t.accessHint} <a href="/account">{t.account}</a></p>}
      <nav className={styles.support} aria-label="Account help">{(!legacyAdmin || accessEnabled) && <a href={mode === "login" ? signupUrl : destination}>{mode === "login" ? t.signUp : t.haveAccount}</a>}{adminEntry && mode === "login" && help !== "MFA_ENROLLMENT_REQUIRED" && <a href={legacyAdmin ? "/access/setup-authenticator" : setupUrl}>{t.setup}</a>}{mode === "login" && <a href={legacyAdmin ? "/account/security?next=/admin" : "/account/security"}>{language === "de" ? "Passwort vergessen?" : "Forgot your password?"}</a>}<a href="/en">{t.back}</a></nav>
    </section>}
  </main>;
}
