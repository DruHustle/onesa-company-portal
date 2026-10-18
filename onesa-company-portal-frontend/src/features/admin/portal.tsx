"use client";
import {
  useState,
  useEffect,
  useLayoutEffect,
  useRef,
  type FormEvent,
} from "react";
import { api, setCsrf, ApiError } from "@/lib/api/client";
import { fileBase64 } from "@/components/application-form";
import { privateDocument } from "@/lib/api/transfers";
import { BackgroundProcessing } from "./background-processing";
import { PrivacyGovernance } from "./privacy-governance";
import { EngineeringMemberships } from "./engineering-memberships";
import { AdminSignIn } from "./sign-in";
import { AccessRequests } from "./access-requests";
import {ApplicationCv} from "./application-cv";
import { RecordPicker } from "./record-picker";
import { useUnsavedWork } from "./use-unsaved-work";
import { EditorialWorkspace } from "./editorial-workspace";
import {
  tabRoles,
  tabLabel,
  taskGroups,
  applicationTransitions,
  labels,
  emptyQueue,
  sectionFromUrl,
  type Tab,
  type QueueState,
} from "./workspace-navigation";
import type { operations } from "@/lib/api/generated/schema";
type User =
  operations["login"]["responses"][200]["content"]["application/json"]["user"];
type Content =
  operations["createContent"]["responses"][201]["content"]["application/json"];
type Enquiry =
  operations["listEnquiries"]["responses"][200]["content"]["application/json"]["items"][number];
type Application =
  operations["listApplications"]["responses"][200]["content"]["application/json"]["items"][number];
type Document =
  operations["uploadDocument"]["responses"][201]["content"]["application/json"];
type Template =
  operations["listTemplates"]["responses"][200]["content"]["application/json"]["items"][number];
type Fact =
  operations["companyFactsRegistry"]["responses"][200]["content"]["application/json"]["items"][number];
type Audit =
  operations["auditHistory"]["responses"][200]["content"]["application/json"]["items"][number];
type Dashboard =
  operations["dashboardSummary"]["responses"][200]["content"]["application/json"];
type Settings =
  operations["getSettings"]["responses"][200]["content"]["application/json"];
const value = (d: FormData, key: string) => String(d.get(key) || "");
const nullable = (d: FormData, key: string) => value(d, key) || null;
const date = (d: FormData, key: string) =>
  value(d, key) ? new Date(value(d, key)).toISOString() : null;
const isoInput = (s: string | null) =>
  s
    ? new Date(new Date(s).getTime() - new Date(s).getTimezoneOffset() * 60000)
        .toISOString()
        .slice(0, 16)
    : "";
function Field({
  label,
  name,
  defaultValue = "",
  type = "text",
  required = false,
}: {
  label: string;
  name: string;
  defaultValue?: string;
  type?: string;
  required?: boolean;
}) {
  return (
    <label>
      {label}
      {type === "datetime-local" ? " (your local time)" : ""}
      <input
        name={name}
        type={type}
        defaultValue={defaultValue}
        required={required}
      />
    </label>
  );
}
function Select<T extends string>({
  label,
  name,
  values,
  defaultValue,
}: {
  label: string;
  name: string;
  values: readonly T[];
  defaultValue?: string;
}) {
  return (
    <label>
      {label}
      <select aria-label={label} name={name} defaultValue={defaultValue}>
        {values.map((v) => (
          <option key={v} value={v}>
            {labels[v] || v.replaceAll("_", " ")}
          </option>
        ))}
      </select>
    </label>
  );
}
export function AdminPortal({
  environment,
  accessEnabled = false,
  engineeringEnabled = false,
}: {
  environment?: "PRODUCTION" | "STAGING" | "DEVELOPMENT";
  accessEnabled?: boolean;
  engineeringEnabled?: boolean;
}) {
  const [user, setUser] = useState<User | null>(null),
    [loading, setLoading] = useState(true),
    [busy, setBusy] = useState(false),
    [notice, setNotice] = useState(""),
    [tab, setTab] = useState<Tab>("Dashboard"),
    [total, setTotal] = useState(0);
  const [sessionAttempt,setSessionAttempt]=useState(0),[sessionError,setSessionError]=useState(''),[sessionChecking,setSessionChecking]=useState(false);
  const [queues, setQueues] = useState<Partial<Record<Tab, QueueState>>>({});
  const queue = queues[tab] || emptyQueue(),
    page = queue.page,
    search = queue.draftSearch;
  const setQueue = (patch: Partial<QueueState>) =>
    setQueues((old) => ({
      ...old,
      [tab]: { ...(old[tab] || emptyQueue()), ...patch },
    }));
  const setPage = (page: number) => setQueue({ page });
  const setSearch = (draftSearch: string) => setQueue({ draftSearch });
  const unsaved = useUnsavedWork(),
    navigate = unsaved.navigate;
  const listRequest = useRef<AbortController | null>(null),
    mutation = useRef(false),
    currentLocation = useRef("");
  const [listLoading, setListLoading] = useState(false),
    [listError, setListError] = useState("");
  const [dashboard, setDashboard] = useState<Dashboard | null>(null),
    [contents, setContents] = useState<Content[]>([]),
    [enquiries, setEnquiries] = useState<Enquiry[]>([]),
    [applications, setApplications] = useState<Application[]>([]),
    [files, setFiles] = useState<Document[]>([]),
    [templates, setTemplates] = useState<Template[]>([]),
    [users, setUsers] = useState<User[]>([]),
    [audits, setAudits] = useState<Audit[]>([]),
    [facts, setFacts] = useState<Fact[]>([]),
    [settings, setSettings] = useState<Settings | null>(null);
  const [enquiry, setEnquiry] = useState<Enquiry | null>(null),
    [application, setApplication] = useState<Application | null>(null),
    [document, setDocument] = useState<Document | null>(null),
    [template, setTemplate] = useState<Template | null>(null),
    [editUser, setEditUser] = useState<User | null>(null);
  const [enrollment, setEnrollment] = useState<
      | operations["startMfaEnrollment"]["responses"][200]["content"]["application/json"]
      | null
    >(null),
    [recovery, setRecovery] = useState<string[]>([]);
  async function perform(fn: () => Promise<void>, success = "Saved") {
    if (mutation.current) return;
    mutation.current = true;
    setBusy(true);
    setNotice("");
    try {
      await fn();
      setNotice(success);
    } catch (e) {
      setNotice(
        e instanceof ApiError
          ? `${e.message} · Request ${e.requestId || e.status}`
          : e instanceof Error
            ? e.message
            : "Request failed",
      );
    } finally {
      mutation.current = false;
      setBusy(false);
    }
  }
  useEffect(() => {
    const url = new URL(window.location.href),
      initial = sectionFromUrl(url);
    setTab(initial);
    setQueues({
      [initial]: {
        ...emptyQueue(),
        page: Math.max(
          1,
          Math.min(10000, Number(url.searchParams.get("page")) || 1),
        ),
        search: url.searchParams.get("search") || "",
        draftSearch: url.searchParams.get("search") || "",
        status: url.searchParams.get("status") || undefined,
        category: url.searchParams.get("category") || undefined,
      },
    });
    const sessionRequest=new AbortController();setSessionChecking(true);setSessionError('');
    api
      .GET("/api/v1/auth/me",{signal:sessionRequest.signal})
      .then((r) => {
        if (r.data&&!sessionRequest.signal.aborted) {
          setUser(r.data.user);
          if (
            !(tabRoles[initial] as readonly string[]).includes(r.data.user.role)
          )
            setTab("Dashboard");
          setCsrf(r.data.csrf);
        }
      })
      .catch(error => {if(sessionRequest.signal.aborted)return;if(error instanceof ApiError&&error.status===401)return;setSessionError(error instanceof ApiError&&error.status===403?'Access to this Portal session was denied. Use an approved account.':'We could not check your Portal session. The service may be unavailable; retry the session check or sign in when it recovers.');})
      .finally(() => {if(!sessionRequest.signal.aborted){setLoading(false);setSessionChecking(false);}});
    return()=>sessionRequest.abort();
  }, [sessionAttempt]);
  async function load(current: Tab = tab, p = page, q = queue.search) {
    listRequest.current?.abort();
    const controller = new AbortController();
    listRequest.current = controller;
    setListLoading(true);
    setListError("");
    const query = {
      page: p,
      limit: 20,
      search: q,
      status: queue.status,
      category: queue.category,
    };
    try {
      switch (current) {
        case "Dashboard": {
          const r = await api.GET("/api/v1/admin/dashboard");
          if (controller.signal.aborted) return;
          setDashboard(r.data!);
          break;
        }
        case "Content": {
          const r = await api.GET("/api/v1/admin/content", {
            params: { query },
            signal: controller.signal,
          });
          if (controller.signal.aborted) return;
          setContents(r.data!.items);
          setTotal(r.data!.total);
          break;
        }
        case "Enquiries": {
          const r = await api.GET("/api/v1/admin/enquiries", {
            params: { query },
            signal: controller.signal,
          });
          if (controller.signal.aborted) return;
          setEnquiries(r.data!.items);
          setTotal(r.data!.total);
          break;
        }
        case "Applications": {
          const r = await api.GET("/api/v1/admin/applications", {
            params: { query },
            signal: controller.signal,
          });
          if (controller.signal.aborted) return;
          setApplications(r.data!.items);
          setTotal(r.data!.total);
          break;
        }
        case "Documents": {
          const r = await api.GET("/api/v1/admin/files", {
            params: { query },
            signal: controller.signal,
          });
          if (controller.signal.aborted) return;
          setFiles(r.data!.items);
          setTotal(r.data!.total);
          break;
        }
        case "Templates": {
          const r = await api.GET("/api/v1/admin/templates", {
            params: { query },
            signal: controller.signal,
          });
          if (controller.signal.aborted) return;
          setTemplates(r.data!.items);
          setTotal(r.data!.total);
          break;
        }
        case "Users": {
          const r = await api.GET("/api/v1/admin/users", {
            params: { query },
            signal: controller.signal,
          });
          if (controller.signal.aborted) return;
          setUsers(r.data!.items);
          setTotal(r.data!.total);
          break;
        }
        case "Audit": {
          const r = await api.GET("/api/v1/admin/audit", {
            params: { query },
            signal: controller.signal,
          });
          if (controller.signal.aborted) return;
          setAudits(r.data!.items);
          setTotal(r.data!.total);
          break;
        }
        case "Facts": {
          const r = await api.GET("/api/v1/admin/facts");
          if (controller.signal.aborted) return;
          setFacts(r.data!.items);
          break;
        }
        case "Settings": {
          const r = await api.GET("/api/v1/admin/settings");
          if (controller.signal.aborted) return;
          setSettings(r.data!);
          break;
        }
        default:
          break;
      }
    } catch (error) {
      if (!controller.signal.aborted) {
        const message =
          error instanceof ApiError
            ? error.status === 401
              ? "Your session has expired. Sign in again; unsaved fields remain on this page."
              : error.status === 403
                ? "You do not have access to this queue."
                : `${error.message} · Reference ${error.requestId || error.status}`
            : "The service could not be reached. Try loading again.";
        setListError(message);
      }
    } finally {
      if (!controller.signal.aborted) setListLoading(false);
    }
  }
  useEffect(() => {
    if (user && (tabRoles[tab] as readonly string[]).includes(user.role))
      void load();
    return () => listRequest.current?.abort();
  }, [user, tab, page, queue.search, queue.status, queue.category]);
  useEffect(() => {
    if (!user) return;
    const url = new URL(window.location.href);
    url.searchParams.set("section", tab);
    url.searchParams.set("page", String(page));
    for (const [key, value] of Object.entries({
      search: queue.search,
      status: queue.status,
      category: queue.category,
    })) {
      if (value) url.searchParams.set(key, value);
      else url.searchParams.delete(key);
    }
    window.history.replaceState(window.history.state, "", url);
    currentLocation.current = url.href;
  }, [user, tab, page, queue.search, queue.status, queue.category]);
  useEffect(() => {
    const back = () => {
      const url = new URL(window.location.href),
        next = sectionFromUrl(url);
      if (user && !(tabRoles[next] as readonly string[]).includes(user.role))
        return;
      const previous = new URL(window.location.href);
      previous.searchParams.set("section", tab);
      let moved = false;
      navigate(() => {
        moved = true;
        setTab(next);
        setQueues((old) => ({
          ...old,
          [next]: {
            ...emptyQueue(),
            page: Math.max(1, Number(url.searchParams.get("page")) || 1),
            search: url.searchParams.get("search") || "",
            draftSearch: url.searchParams.get("search") || "",
            status: url.searchParams.get("status") || undefined,
            category: url.searchParams.get("category") || undefined,
          },
        }));
      });
      if (!moved)
        window.history.replaceState(
          window.history.state,
          "",
          currentLocation.current || previous,
        );
    };
    window.addEventListener("popstate", back);
    return () => window.removeEventListener("popstate", back);
  }, [tab, user]);
  function openSection(next: Tab, filters?: Partial<QueueState>) {
    navigate(() => {
      listRequest.current?.abort();
      const url = new URL(window.location.href);
      url.searchParams.set("section", next);
      window.history.pushState(window.history.state, "", url);
      if (filters)
        setQueues((old) => ({
          ...old,
          [next]: { ...emptyQueue(), ...filters },
        }));
      setTab(next);
      setTotal(0);
      setNotice("");
    });
  }
  useLayoutEffect(() => {
    if (user) window.document.getElementById("workspace-heading")?.focus();
  }, [tab]);
  const refresh = () => load();
  function submitted(fn: (data: FormData) => Promise<void>) {
    return (e: FormEvent<HTMLFormElement>) => {
      e.preventDefault();
      const form = e.currentTarget;
      const data = new FormData(form);
      void perform(async () => {
        try {
          await fn(data);
          unsaved.saved(form);
        } finally {
          for (const input of form.querySelectorAll<HTMLInputElement>(
            "input[type=password],input[name=stepUpCode]",
          ))
            input.value = "";
        }
      });
    };
  }
  async function download(id: string, filename?:string) {
    await perform(async () => {
      const blob = await privateDocument(id);
      const url = URL.createObjectURL(blob);
      const a = window.document.createElement("a");
      a.href = url;
      a.download = filename||files.find((f) => f.id === id)?.filename || "document.pdf";
      a.hidden = true;
      window.document.body.append(a);
      a.click();
      window.setTimeout(() => {
        a.remove();
        URL.revokeObjectURL(url);
      }, 1000);
    }, "Download authorized");
  }
  if (loading) return <main className="section"><h1>Company administration</h1><p role="status">Checking your Portal session…</p></main>;
  if (!user)
    return (
      <main className="admin-shell">
        <header className="admin-header">
          <a className="wordmark" href="/en">
            onesa<span>UG</span>
          </a>
          <span>Company administration</span>
        </header>
        <div className="admin-login">
          <h1 style={{ fontSize: "2rem" }}>Sign in</h1>
          {sessionError&&<div role="alert"><p>{sessionError}</p><button type="button" disabled={sessionChecking} onClick={()=>setSessionAttempt(value=>value+1)}>Retry session check</button></div>}{sessionChecking&&<p role="status">Checking your Portal session…</p>}
          <AdminSignIn
            accessEnabled={accessEnabled}
            onSignedIn={(r) => {
              setCsrf(r.csrf);
              setSessionError('');setUser(r.user);
            }}
          />
          <details>
            <summary>Enroll a new administrator’s authenticator</summary>
            <p>
              Complete registration and receive approval first. Existing MFA
              cannot be replaced here.
            </p>
            <form
              data-workspace-draft
              onSubmit={submitted(async (d) => {
                const r = await api.POST("/api/v1/auth/mfa/enroll", {
                  body: {
                    email: value(d, "email"),
                    password: value(d, "password"),
                  },
                });
                setEnrollment(r.data!);
              })}
            >
              <Field label="Email" name="email" type="email" required />
              <Field
                label="Password"
                name="password"
                type="password"
                required
              />
              <button disabled={busy}>Start enrollment</button>
            </form>
            {enrollment && (
              <>
                <p>Enter this secret in your authenticator. Do not share it.</p>
                <pre
                  style={{ overflowWrap: "anywhere", whiteSpace: "pre-wrap" }}
                >
                  {enrollment.secret}
                </pre>
                <form
                  data-workspace-draft
                  onSubmit={submitted(async (d) => {
                    const r = await api.POST("/api/v1/auth/mfa/verify", {
                      body: {
                        challenge: enrollment.challenge,
                        code: value(d, "code"),
                      },
                    });
                    setRecovery(r.data!.recoveryCodes);
                    setEnrollment(null);
                  })}
                >
                  <Field label="Authenticator code" name="code" required />
                  <button disabled={busy}>Verify enrollment</button>
                </form>
              </>
            )}
          </details>
          <details>
            <summary>Recover your password</summary>
            <form
              data-workspace-draft
              onSubmit={submitted(async (d) => {
                await api.POST("/api/v1/auth/password/request", {
                  body: { email: value(d, "email") },
                });
              })}
            >
              <Field label="Email" name="email" type="email" required />
              <button disabled={busy}>Request recovery</button>
            </form>
            <form
              data-workspace-draft
              onSubmit={submitted(async (d) => {
                await api.POST("/api/v1/auth/password/reset", {
                  body: {
                    token: value(d, "token"),
                    password: value(d, "password"),
                  },
                });
              })}
            >
              <Field label="Recovery token from email" name="token" required />
              <Field
                label="New password (14+ characters)"
                name="password"
                type="password"
                required
              />
              <button disabled={busy}>Reset password</button>
            </form>
            <p>
              MFA remains required after password recovery. Email must be
              configured to deliver the recovery token.
            </p>
          </details>
          {recovery.length > 0 && (
            <div className="admin-notice">
              <p>Save these one-use recovery codes securely:</p>
              <pre>{recovery.join("\n")}</pre>
              <button onClick={() => setRecovery([])}>
                I have saved the codes
              </button>
            </div>
          )}
          <p role="status" className="admin-notice">
            {notice}
          </p>
        </div>
      </main>
    );
  return (
    <main className="admin-shell">
      <header className="admin-header">
        <a href="/en" className="wordmark">
          onesa<span>UG</span>
        </a>
        <div className="admin-product-title">
          <strong>Onesa Company Portal</strong>
          <small>Administration · Internal</small>
          {environment && (
            <span className="environment-label">{environment}</span>
          )}
        </div>
        <span>
          {user.email} · {user.role}
        </span>
        <button
          onClick={() =>
            navigate(() => {
              void perform(async () => {
                await api.POST("/api/v1/auth/logout", { body: {} });
                setCsrf(undefined);
                setUser(null);
              });
            })
          }
          disabled={busy}
        >
          Sign out
        </button>
      </header>
      <div className="admin-main">
        <h1 style={{ fontSize: "2.4rem" }}>Company workspace</h1>
        <p>Manage the website, respond to enquiries and review applications.</p>
        <div className="admin-workspace">
          <nav className="admin-tabs" aria-label="Administration">
            {taskGroups.map((group) => {
              const tabs = group.tabs.filter((name) =>
                (tabRoles[name] as readonly string[]).includes(user.role),
              );
              return tabs.length ? (
                <div className="admin-task-group" key={group.label}>
                  <h2>{group.label}</h2>
                  {tabs.map((name) => (
                    <button
                      key={name}
                      disabled={busy}
                      aria-current={tab === name ? "page" : undefined}
                      aria-pressed={tab === name}
                      onClick={() => openSection(name)}
                    >
                      {tabLabel[name]}
                    </button>
                  ))}
                </div>
              ) : null;
            })}
          </nav>
          <div
            className="admin-content"
            onFocusCapture={unsaved.focus}
            onChangeCapture={unsaved.input}
          >
            <h2 id="workspace-heading" tabIndex={-1}>
              {tabLabel[tab]}
            </h2>
            {unsaved.dirty && (
              <p role="status">
                Unsaved changes — save before leaving this task.
              </p>
            )}
            {listError && (
              <div role="alert">
                <p>{listError}</p>
                <button disabled={listLoading} onClick={() => void load()}>
                  Try loading again
                </button>
              </div>
            )}
            {listLoading && <p role="status">Loading this queue…</p>}
            <p
              role="status"
              className="admin-notice"
              data-workspace-notice="true"
            >
              {busy ? "Working…" : notice}
            </p>
            {![
              "Dashboard",
              "Facts",
              "Settings",
              "Security",
              "Governance & Compliance",
              "Background Processing",
            ].includes(tab) && (
              <div className="admin-actions">
                <input
                  aria-label="Search records"
                  style={{ maxWidth: 300 }}
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                />
                {(
                  ["Content", "Enquiries", "Applications", "Documents"] as Tab[]
                ).includes(tab) && (
                  <label>
                    Filter by status
                    <select
                      value={queue.status || ""}
                      onChange={(event) =>
                        navigate(() =>
                          setQueue({
                            page: 1,
                            status: event.target.value || undefined,
                          }),
                        )
                      }
                    >
                      <option value="">All statuses</option>
                      {(tab === "Content"
                        ? ["draft", "published", "archived"]
                        : tab === "Enquiries"
                          ? ["new", "active", "closed"]
                          : tab === "Applications"
                            ? [
                                "new",
                                "review",
                                "interview",
                                "rejected",
                                "hired",
                              ]
                            : ["pending", "approved", "rejected"]
                      ).map((status) => (
                        <option key={status} value={status}>
                          {labels[status] || status}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
                <button
                  onClick={() => setQueue({ page: 1, search: search.trim() })}
                >
                  Search
                </button>
                <button
                  disabled={listLoading || busy || page <= 1}
                  onClick={() => setPage(page - 1)}
                >
                  Previous
                </button>
                <span aria-live="polite">
                  Page {page} · {total} records
                </span>
                <button
                  disabled={busy}
                  onClick={() =>
                    navigate(() =>
                      setQueues((old) => ({ ...old, [tab]: emptyQueue() })),
                    )
                  }
                >
                  Reset filters
                </button>
                {(queue.search || queue.status || queue.category) && (
                  <p>
                    Active filters:{" "}
                    {[queue.search, queue.status, queue.category]
                      .filter(Boolean)
                      .join(" · ")}
                  </p>
                )}
                {!listLoading && !listError && total === 0 && (
                  <p>
                    {queue.search || queue.status || queue.category
                      ? "No results match these filters."
                      : "There are no records in this queue yet."}
                  </p>
                )}
                <button
                  disabled={listLoading || busy || page * 20 >= total}
                  onClick={() => setPage(page + 1)}
                >
                  Next
                </button>
              </div>
            )}
            {tab === "Background Processing" &&
              ["owner", "administrator"].includes(user.role) && (
                <BackgroundProcessing />
              )}
            {tab === "Governance & Compliance" &&
              ["owner", "administrator"].includes(user.role) && (
                <PrivacyGovernance role={user.role} />
              )}
            {tab === "Dashboard" && dashboard && (
              <>
                <div className="admin-stats">
                  {Object.entries(dashboard)
                    .filter(([, value]) => typeof value === "number")
                    .map(([key, value]) => (
                      <button
                        className="admin-card"
                        key={key}
                        onClick={() => {
                          const destinations: Record<
                            string,
                            [Tab, Partial<QueueState>]
                          > = {
                            enquiries: ["Enquiries", { status: "new" }],
                            partnerships: [
                              "Enquiries",
                              { category: "partnership" },
                            ],
                            applications: ["Applications", { status: "new" }],
                            documents: ["Documents", { status: "pending" }],
                            drafts: ["Content", { status: "draft" }],
                            published: ["Content", { status: "published" }],
                            pendingJobs: ["Background Processing", {}],
                          };
                          const destination = destinations[key];
                          if (destination) openSection(...destination);
                        }}
                      >
                        <strong>{String(value)}</strong>
                        {labels[key] || key}
                      </button>
                    ))}
                </div>
                <p>
                  Publication:{" "}
                  {dashboard.publicationStage === "prelaunch"
                    ? "Pre-launch — features enabled; legal review deferred by owner"
                    : dashboard.releaseReady
                      ? "launch requirements approved"
                      : "launch held pending verified facts and legal approval"}
                </p>
              </>
            )}
            {tab === "Content" && (
              <EditorialWorkspace
                items={contents} draftDirty={unsaved.draftDirty}
                role={user.role}
                busy={busy}
                refresh={refresh}
                navigate={navigate}
                perform={perform}
                submitted={submitted}
              />
            )}
            {tab === "Enquiries" && (
              <div className="admin-grid">
                <div className="admin-list">
                  {enquiries.length === 0 && <p>No enquiries.</p>}
                  {enquiries.map((e) => (
                    <button
                      key={e.id}
                      onClick={() => navigate(() => setEnquiry(e))}
                    >
                      {e.name} · {e.organization}
                      <small>
                        {e.category} · {e.status} · {e.created_at}
                      </small>
                    </button>
                  ))}
                </div>
                {enquiry && (
                  <form
                    data-workspace-draft
                    key={enquiry.id}
                    className="admin-card"
                    onSubmit={submitted(async (d) => {
                      const r = await api.PATCH(
                        "/api/v1/admin/enquiries/{id}",
                        {
                          params: { path: { id: enquiry.id } },
                          body: {
                            status: value(d, "status") as Enquiry["status"],
                            notes: value(d, "notes"),
                            ownerId: nullable(d, "ownerId"),
                            followUpAt: date(d, "followUpAt"),
                          },
                        },
                      );
                      setEnquiry(r.data!);
                      await refresh();
                    })}
                  >
                    <h2>{enquiry.name}</h2>
                    <p>
                      {enquiry.email} · {enquiry.category}
                    </p>
                    <p style={{ whiteSpace: "pre-wrap" }}>{enquiry.message}</p>
                    <Select
                      label="Status"
                      name="status"
                      values={
                        enquiry.status === "closed"
                          ? ["closed", "active"]
                          : ["new", "active", "closed"]
                      }
                      defaultValue={enquiry.status}
                    />
                    <RecordPicker
                      kind="staff"
                      label="Assigned staff"
                      name="ownerId"
                      initial={enquiry.owner_id || undefined}
                      key={enquiry.id}
                    />
                    <Field
                      label="Follow-up"
                      name="followUpAt"
                      type="datetime-local"
                      defaultValue={isoInput(enquiry.follow_up_at)}
                    />
                    <label>
                      Internal notes
                      <textarea
                        name="notes"
                        rows={5}
                        defaultValue={enquiry.notes}
                      />
                    </label>
                    <button className="button" disabled={busy}>
                      Update enquiry
                    </button>
                    <div className="admin-actions">
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() =>
                          void perform(async () => {
                            if (
                              !window.confirm(
                                `Delete the enquiry from ${enquiry.name} (${enquiry.email})? Reference: ${enquiry.id}. This removes the enquiry and its notes; audit and required erasure evidence remain. This cannot be undone here. Preservation holds can block deletion.`,
                              )
                            )
                              throw new Error(
                                "Deletion cancelled. No record was changed.",
                              );
                            await api.DELETE("/api/v1/admin/enquiries/{id}", {
                              params: { path: { id: enquiry.id } },
                              body: {},
                            });
                            setEnquiry(null);
                            await refresh();
                          }, "Deleted")
                        }
                      >
                        Delete personal data
                      </button>
                    </div>
                  </form>
                )}
              </div>
            )}
            {tab === "Applications" && (
              <div className="admin-grid">
                <div className="admin-list">
                  {applications.length === 0 && <p>No applications.</p>}
                  {applications.map((a) => (
                    <button
                      key={a.id}
                      onClick={() => navigate(() => setApplication(a))}
                    >
                      {a.name}
                      <small>
                        {a.status} · {a.created_at}
                      </small>
                    </button>
                  ))}
                </div>
                {application && (
                  <form
                    data-workspace-draft
                    key={application.id}
                    className="admin-card"
                    onSubmit={submitted(async (d) => {
                      const r = await api.PATCH(
                        "/api/v1/admin/applications/{id}",
                        {
                          params: { path: { id: application.id } },
                          body: {
                            status: value(d, "status") as Application["status"],
                            notes: value(d, "notes"),
                            deleteAfter: date(d, "deleteAfter") || undefined,
                          },
                        },
                      );
                      setApplication(r.data!);
                      await refresh();
                    })}
                  >
                    <h2>{application.name}</h2>
                    <p>{application.email}</p>
                    <p>{application.message}</p>
                    <Select
                      label="Status"
                      name="status"
                      values={applicationTransitions[application.status]}
                      defaultValue={application.status}
                    />
                    <Field
                      label="Delete after"
                      name="deleteAfter"
                      type="datetime-local"
                      defaultValue={isoInput(application.delete_after)}
                    />
                    <label>
                      Review notes
                      <textarea
                        name="notes"
                        rows={5}
                        defaultValue={application.notes}
                      />
                    </label>
                    <button className="button" disabled={busy}>
                      Update application
                    </button>
                    <div className="admin-actions">
                      <ApplicationCv key={application.file_id} fileId={application.file_id} busy={busy} onDownload={filename=>void download(application.file_id,filename)}/>
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() =>
                          void perform(async () => {
                            if (
                              !window.confirm(
                                `Delete the application from ${application.name} (${application.email})? Reference: ${application.id}. This removes the application, notes and linked CV; file cleanup is queued. Audit and required erasure evidence remain. There is no Undo here. Preservation holds can block deletion.`,
                              )
                            )
                              throw new Error(
                                "Deletion cancelled. No record was changed.",
                              );
                            await api.DELETE(
                              "/api/v1/admin/applications/{id}",
                              {
                                params: { path: { id: application.id } },
                                body: {},
                              },
                            );
                            setApplication(null);
                            await refresh();
                          }, "Application removed; CV storage deletion queued")
                        }
                      >
                        Delete application and CV
                      </button>
                    </div>
                  </form>
                )}
              </div>
            )}
            {tab === "Documents" && (
              <div className="admin-grid">
                <div>
                  <div className="admin-list">
                    {files.length === 0 && <p>No documents.</p>}
                    {files.map((f) => (
                      <button
                        key={f.id}
                        onClick={() => navigate(() => setDocument(f))}
                      >
                        {f.title}
                        <small>
                          {f.classification} · {f.approval} · {f.scan_status} ·
                          v{f.version}
                          {f.archived ? " · archived" : ""}
                        </small>
                      </button>
                    ))}
                  </div>
                  {user.role !== "hr" && (
                    <form
                      data-workspace-draft
                      className="admin-card"
                      onSubmit={submitted(async (d) => {
                        const f = d.get("file") as File;
                        await api.POST("/api/v1/admin/files", {
                          body: {
                            filename: f.name,
                            base64: await fileBase64(f),
                            title: value(d, "title"),
                            classification: value(d, "classification") as
                              "public" | "internal" | "confidential",
                            reviewAt: date(d, "reviewAt"),
                            association: value(d, "association"),
                            parentId: nullable(d, "parentId") || undefined,
                          },
                        });
                        await refresh();
                      })}
                    >
                      <h2>Upload document</h2>
                      <Field label="Title" name="title" required />
                      <Select
                        label="Classification"
                        name="classification"
                        values={["internal", "confidential", "public"]}
                      />
                      <Field
                        label="Review date"
                        name="reviewAt"
                        type="datetime-local"
                      />
                      <Field label="Associated record" name="association" />
                      <RecordPicker
                        kind="document"
                        label="Previous document version (optional)"
                        name="parentId"
                      />
                      <label>
                        PDF or image (up to 10 MB)
                        <input
                          type="file"
                          name="file"
                          accept="application/pdf,image/png,image/jpeg,image/webp,.pdf"
                          required
                        />
                      </label>
                      <button className="button" disabled={busy}>
                        Upload to quarantine
                      </button>
                    </form>
                  )}
                </div>
                {document && (
                  <div className="admin-card">
                    <h2>{document.title}</h2>
                    <p>
                      Scan: {document.scan_status} · version {document.version}
                    </p>
                    <div className="admin-actions">
                      <button onClick={() => void download(document.id)}>
                        Download
                      </button>
                      {["owner", "administrator"].includes(user.role) && (
                        <button
                          onClick={() =>
                            void perform(async () => {
                              const r = await api.POST(
                                "/api/v1/admin/files/{id}/scan",
                                {
                                  params: { path: { id: document.id } },
                                  body: {},
                                },
                              );
                              setDocument(r.data!);
                              await refresh();
                            }, "Scan completed")
                          }
                        >
                          Scan again
                        </button>
                      )}
                    </div>
                    {document.classification !== "applicant" && (
                      <form
                        data-workspace-draft
                        key={document.id}
                        onSubmit={submitted(async (d) => {
                          const r = await api.PATCH(
                            "/api/v1/admin/files/{id}",
                            {
                              params: { path: { id: document.id } },
                              body: {
                                title: value(d, "title"),
                                classification: value(d, "classification") as
                                  "public" | "internal" | "confidential",
                                approval: value(
                                  d,
                                  "approval",
                                ) as Document["approval"],
                                reviewAt: date(d, "reviewAt"),
                                archived: d.get("archived") === "on",
                              },
                            },
                          );
                          setDocument(r.data!);
                          await refresh();
                        })}
                      >
                        <Field
                          label="Title"
                          name="title"
                          defaultValue={document.title}
                        />
                        <Select
                          label="Classification"
                          name="classification"
                          values={["internal", "confidential", "public"]}
                          defaultValue={document.classification}
                        />
                        <Select
                          label="Approval"
                          name="approval"
                          values={["pending", "approved", "rejected"]}
                          defaultValue={document.approval}
                        />
                        <Field
                          label="Review date"
                          name="reviewAt"
                          type="datetime-local"
                          defaultValue={isoInput(document.review_at)}
                        />
                        <label className="check">
                          <input
                            name="archived"
                            type="checkbox"
                            defaultChecked={document.archived}
                          />
                          Archived
                        </label>
                        <button className="button" disabled={busy}>
                          Save approval and classification
                        </button>
                      </form>
                    )}
                  </div>
                )}
              </div>
            )}
            {tab === "Templates" && (
              <div className="admin-grid">
                <div className="admin-list">
                  {templates.map((t) => (
                    <button
                      key={t.key}
                      onClick={() => navigate(() => setTemplate(t))}
                    >
                      {t.title}
                      <small>
                        {t.status} · {t.locale} · v{t.version}
                      </small>
                    </button>
                  ))}
                </div>
                {template && (
                  <div className="admin-card">
                    <form
                      data-workspace-draft
                      key={template.key}
                      onSubmit={submitted(async (d) => {
                        const r = await api.PUT(
                          "/api/v1/admin/templates/{key}",
                          {
                            params: { path: { key: template.key } },
                            body: {
                              title: value(d, "title"),
                              locale: value(d, "locale") as "en" | "de",
                              body: value(d, "body"),
                              status: value(d, "status") as Template["status"],
                              version: template.version,
                            },
                          },
                        );
                        setTemplate(r.data!);
                        await refresh();
                      })}
                    >
                      <Field
                        label="Title"
                        name="title"
                        defaultValue={template.title}
                      />
                      <Select
                        label="Language"
                        name="locale"
                        values={["en", "de"]}
                        defaultValue={template.locale}
                      />
                      <label>
                        Template text
                        <textarea
                          name="body"
                          rows={16}
                          defaultValue={template.body}
                        />
                      </label>
                      <Select
                        label="Approval"
                        name="status"
                        values={["draft", "approved", "archived"]}
                        defaultValue={template.status}
                      />
                      <button className="button" disabled={busy}>
                        Save template
                      </button>
                    </form>
                    <div className="admin-actions">
                      <button
                        onClick={() =>
                          void perform(async () => {
                            await api.POST(
                              "/api/v1/admin/templates/{key}/generate",
                              {
                                params: { path: { key: template.key } },
                                body: { classification: "internal" },
                              },
                            );
                          }, "PDF generated. Review it in Documents.")
                        }
                      >
                        Generate private PDF
                      </button>
                    </div>
                  </div>
                )}
              </div>
            )}
            {tab === "Users" && (
              <p>
                Normal access: register → verify email → owner approval. A
                Portal role grants business-workspace permissions. Engineering
                membership is separate, and the provider’s approved-email policy
                independently controls Docs access.
              </p>
            )}
            {tab === "Users" && (
              <div className="admin-grid">
                <div className="admin-list">
                  <button onClick={() => navigate(() => setEditUser(null))}>
                    Exceptional direct account creation
                  </button>
                  {users.map((u) => (
                    <button
                      key={u.id}
                      onClick={() => navigate(() => setEditUser(u))}
                    >
                      {u.email}
                      <small>
                        {labels[u.role] || u.role} ·{" "}
                        {u.disabled ? "Disabled" : "Active"}{" "}
                      </small>
                    </button>
                  ))}
                </div>
                <form
                  data-workspace-draft
                  key={editUser?.id || "new-user"}
                  className="admin-card"
                  onSubmit={submitted(async (d) => {
                    if (editUser)
                      await api.PATCH("/api/v1/admin/users/{id}", {
                        params: { path: { id: editUser.id } },
                        body: {
                          role: value(d, "role") as User["role"],
                          disabled: d.get("disabled") === "on",
                          resetMfa: d.get("resetMfa") === "on",
                          stepUp: {
                            password: value(d, "stepUpPassword"),
                            code: value(d, "stepUpCode"),
                          },
                        },
                      });
                    else
                      await api.POST("/api/v1/admin/users", {
                        body: {
                          email: value(d, "email"),
                          password: value(d, "password"),
                          role: value(d, "role") as User["role"],
                        },
                      });
                    await refresh();
                  })}
                >
                  <h2>
                    {editUser
                      ? editUser.email
                      : "Exceptional direct account creation"}
                  </h2>
                  {editUser && (
                    <details>
                      <summary>Technical reference</summary>
                      <code>{editUser.id}</code>
                    </details>
                  )}
                  {!editUser && (
                    <p>
                      Normally, a person registers, verifies their email, then
                      an owner approves the requested Portal role or Engineering
                      Docs membership. Direct creation is for separately
                      verified exceptions; it does not configure Engineering
                      Docs access.
                    </p>
                  )}
                  {!editUser && (
                    <>
                      <Field label="Email" name="email" type="email" required />
                      <Field
                        label="Initial password (14+ characters)"
                        name="password"
                        type="password"
                        required
                      />
                    </>
                  )}
                  <Select
                    label="Role"
                    name="role"
                    values={[
                      "owner",
                      "administrator",
                      "editor",
                      "business",
                      "hr",
                      "viewer",
                    ]}
                    defaultValue={editUser?.role || "viewer"}
                  />
                  {editUser && (
                    <>
                      <label className="check">
                        <input
                          name="disabled"
                          type="checkbox"
                          defaultChecked={editUser.disabled}
                        />
                        Disabled (revokes sessions)
                      </label>
                      {user.role === "owner" && (
                        <label className="check">
                          <input name="resetMfa" type="checkbox" />
                          Reset MFA after independently verifying the user’s
                          identity
                        </label>
                      )}
                      <p>
                        Confirm your own credentials for this change. A code
                        used to sign in cannot be reused.
                      </p>
                      <Field
                        label="Your current password"
                        name="stepUpPassword"
                        type="password"
                        required
                      />
                      <Field
                        label="Fresh authenticator or unused recovery code"
                        name="stepUpCode"
                        required
                      />
                    </>
                  )}
                  <button className="button" disabled={busy}>
                    Save user
                  </button>
                  <p>
                    New users must enroll MFA before login. Share the initial
                    password through an approved secure channel.
                  </p>
                </form>
              </div>
            )}
            {tab === "Users" && user.role === "owner" && (
              <>
                {accessEnabled && <AccessRequests />}
                {engineeringEnabled && <EngineeringMemberships />}
              </>
            )}
            {tab === "Audit" && (
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Time</th>
                      <th>Action</th>
                      <th>Actor</th>
                      <th>Record</th>
                      <th>Request</th>
                    </tr>
                  </thead>
                  <tbody>
                    {audits.map((a) => (
                      <tr key={a.id}>
                        <td>{a.created_at}</td>
                        <td>{a.action}</td>
                        <td>{a.actor_id || "system/public"}</td>
                        <td>{a.record_id}</td>
                        <td>{a.request_id}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {tab === "Facts" && (
              <div className="admin-grid">
                {facts.map((f) => (
                  <form
                    data-workspace-draft
                    key={f.key}
                    className="admin-card"
                    onSubmit={submitted(async (d) => {
                      await api.PUT("/api/v1/admin/facts/{key}", {
                        params: { path: { key: f.key } },
                        body: {
                          value: nullable(d, "value"),
                          status: value(d, "status") as Fact["status"],
                          source: value(d, "source"),
                        },
                      });
                      await refresh();
                    })}
                  >
                    <h2>{labels[f.key]||f.key.replaceAll("_"," ").replace(/^./,letter=>letter.toUpperCase())}</h2><details><summary>Technical reference</summary><code>{f.key}</code></details>
                    <Field
                      label="Value"
                      name="value"
                      defaultValue={f.value || ""}
                    />
                    <Select
                      label="Verification status"
                      name="status"
                      values={["missing", "supplied", "verified"]}
                      defaultValue={f.status}
                    />
                    <Field
                      label="Source / official verification reference"
                      name="source"
                      defaultValue={f.source}
                    />
                    <button className="button" disabled={busy}>
                      Record verification
                    </button>
                  </form>
                ))}
              </div>
            )}
            {tab === "Settings" && settings && (
              <div className="admin-grid">
                <form
                  data-workspace-draft
                  className="admin-card"
                  onSubmit={submitted(async (d) => {
                    await api.PUT("/api/v1/admin/settings", {
                      body: {
                        legal: {
                          impressumApproved:
                            d.get("impressumApproved") === "on",
                          privacyApproved: d.get("privacyApproved") === "on",
                          recruitmentApproved:
                            d.get("recruitmentApproved") === "on",
                          providersReviewed:
                            d.get("providersReviewed") === "on",
                        },
                        retention: {
                          enquiryDays: Number(value(d, "enquiryDays")),
                          applicationDays: Number(value(d, "applicationDays")),
                        },
                      },
                    });
                    await refresh();
                  })}
                >
                  <h2>Website operating flags and provisional settings</h2>
                  <p>
                    These flags do not approve governance documents or processor
                    arrangements. Versioned policy review, holds and controlled
                    erasure remain separate tasks in Privacy governance.
                  </p>
                  <p>
                    These legacy duration values do not activate business-data
                    expiry. Review effective policies and evidence in Governance
                    &amp; Compliance before any separately qualified deletion
                    automation.
                  </p>
                  {Object.entries(settings.legal).map(([key, v]) => (
                    <label className="check" key={key}>
                      <input name={key} type="checkbox" defaultChecked={v} />
                      {labels[key]||key.replaceAll('_',' ')}
                    </label>
                  ))}
                  <Field
                    label="Closed enquiry retention (days)"
                    name="enquiryDays"
                    type="number"
                    defaultValue={String(settings.retention.enquiryDays)}
                  />
                  <Field
                    label="Application retention (days)"
                    name="applicationDays"
                    type="number"
                    defaultValue={String(settings.retention.applicationDays)}
                  />
                  <p>
                    Approval requires an actual legal review and matching
                    approved legal content. Environment publication gates remain
                    separate.
                  </p>
                  <button className="button" disabled={busy}>
                    Save reviewed settings
                  </button>
                </form>
                <div className="admin-card">
                  <h2>Personal data export</h2>
                  <button
                    onClick={() =>
                      void perform(async () => {
                        const r = await api.GET("/api/v1/admin/export");
                        const url = URL.createObjectURL(
                          new Blob([JSON.stringify(r.data, null, 2)], {
                            type: "application/json",
                          }),
                        );
                        const a = window.document.createElement("a");
                        a.href = url;
                        a.download = "onesa-business-data.json";
                        a.hidden = true;
                        window.document.body.append(a);
                        a.click();
                        window.setTimeout(() => {
                          a.remove();
                          URL.revokeObjectURL(url);
                        }, 1000);
                      }, "Exported securely")
                    }
                  >
                    Export business records
                  </button>
                </div>
              </div>
            )}
            {tab === "Security" && (
              <div className="admin-grid">
                <form
                  data-workspace-draft
                  className="admin-card"
                  onSubmit={submitted(async (d) => {
                    if (value(d, "newPassword") !== value(d, "confirmPassword"))
                      throw new Error("New passwords must match");
                    await api.POST("/api/v1/auth/password/change", {
                      body: {
                        password: value(d, "newPassword"),
                        stepUp: {
                          password: value(d, "stepUpPassword"),
                          code: value(d, "stepUpCode"),
                        },
                      },
                    });
                    setUser(null);
                    setCsrf(undefined);
                    setRecovery([]);
                    setEnrollment(null);
                  })}
                >
                  <h2>Change your password</h2>
                  <p>
                    Use at least 14 characters. All sessions will be signed out.
                    MFA stays enabled. Use a fresh authenticator code or an
                    unused recovery code.
                  </p>
                  <Field
                    label="Your current password"
                    name="stepUpPassword"
                    type="password"
                    required
                  />
                  <Field
                    label="Fresh authenticator or unused recovery code"
                    name="stepUpCode"
                    required
                  />
                  <Field
                    label="New password"
                    name="newPassword"
                    type="password"
                    required
                  />
                  <Field
                    label="Confirm new password"
                    name="confirmPassword"
                    type="password"
                    required
                  />
                  <button className="button" disabled={busy}>
                    Change password and sign out
                  </button>
                </form>
                <div className="admin-card">
                  <h2>Session controls</h2>
                  <div className="admin-actions">
                    <button
                      onClick={() =>
                        void perform(async () => {
                          const r = await api.POST("/api/v1/auth/renew", {
                            body: {},
                          });
                          setCsrf(r.data!.csrf);
                        }, "Session renewed")
                      }
                    >
                      Renew this session
                    </button>
                    <button
                      onClick={() =>
                        void perform(async () => {
                          await api.POST("/api/v1/auth/revoke", { body: {} });
                          setUser(null);
                          setCsrf(undefined);
                        }, "All sessions revoked")
                      }
                    >
                      Revoke all my sessions
                    </button>
                  </div>
                </div>
                <div className="admin-card">
                  <h2>Replace recovery codes</h2>
                  <form
                    data-workspace-draft
                    onSubmit={submitted(async (d) => {
                      const r = await api.POST("/api/v1/auth/mfa/recovery", {
                        body: {
                          password: value(d, "password"),
                          code: value(d, "code"),
                        },
                      });
                      setRecovery(r.data!.recoveryCodes);
                    })}
                  >
                    <Field
                      label="Password"
                      name="password"
                      type="password"
                      required
                    />
                    <Field
                      label="Fresh authenticator code"
                      name="code"
                      required
                    />
                    <button className="button" disabled={busy}>
                      Generate new recovery codes
                    </button>
                  </form>
                  {recovery.length > 0 && (
                    <>
                      <pre>{recovery.join("\n")}</pre>
                      <button onClick={() => setRecovery([])}>
                        Codes saved securely
                      </button>
                    </>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </main>
  );
}
