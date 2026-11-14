const interactionId = /^[A-Za-z0-9_-]{8,128}$/;
const engineeringPath = /^\/engineering\/sign-in\/[A-Za-z0-9_-]{8,128}$/;
const productInteractionPath = /^\/account\/sign-in\/[A-Za-z0-9_-]{8,128}$/;

/** The account login may return only to an existing local Docs interaction. */
export function accountReturnPath(search: string): string | null {
  const values = new URLSearchParams(search).getAll("returnTo");
  return values.length === 1 && engineeringPath.test(values[0]) ? values[0] : null;
}

export function accountReauthenticationRequired(search: string): boolean {
  const values = new URLSearchParams(search).getAll("reauthenticate");
  return accountReturnPath(search) !== null && values.length === 1 && values[0] === "1";
}

/** Enrollment creates no session. Docs must return through fresh central login. */
export function accountSetupReturnPath(search: string): string {
  const values = new URLSearchParams(search).getAll("returnTo");
  if (values.length !== 1) return "/account";
  if (values[0] === "/admin") return "/admin?next=/admin";
  if (productInteractionPath.test(values[0])) return values[0];
  if (engineeringPath.test(values[0])) return "/account?returnTo=" + encodeURIComponent(values[0]) + "&reauthenticate=1";
  return "/account";
}

/** No arbitrary origin, query, fragment or product callback is accepted here. */
export function engineeringAccountSignInPath(uid: string): string | null {
  return interactionId.test(uid) ? "/account?returnTo=" + encodeURIComponent("/engineering/sign-in/" + uid) : null;
}

/** Only an opaque interaction ID crosses into the shared account page. */
export function docsAccountPath(uid: string): string | null {
  return interactionId.test(uid) ? "/admin?docs=" + uid : null;
}

/** Keep a product signup in its existing, browser-bound Portal interaction. */
export function productAccountPath(uid: string): string | null {
  return interactionId.test(uid) ? "/admin?interaction=" + uid : null;
}

export function accountDestination(search: string): string {
  const query = new URLSearchParams(search);
  if (query.has("interaction")) {
    return query.size === 1 ? productAccountPath(query.get("interaction")!) ?? "/account" : "/account";
  }
  const docs = query.getAll("docs"), next = query.getAll("next");
  if (docs.length === 1 && !next.length && !query.has("returnTo")) return docsAccountPath(docs[0]) ?? "/account";
  const previous = accountReturnPath(search);
  if (previous && !docs.length && !next.length) return docsAccountPath(previous.slice("/engineering/sign-in/".length)) ?? "/account";
  if (!docs.length && !query.has("returnTo") && next.length === 1 && ["/admin", "/engineering", "/account/delete"].includes(next[0])) return "/account?next=" + next[0];
  return "/account";
}

// Workspace filters and privacy anchors stay in the browser fragment during sign-in.
const workspaceParameters = ["section", "page", "search", "status", "category"];
function adminWorkspaceSuffix(url: URL): string {
  const query = new URLSearchParams();
  for (const key of workspaceParameters) {
    const value = url.searchParams.get(key);
    if (value && value.length <= 256 && url.searchParams.getAll(key).length === 1) query.set(key, value);
  }
  const hash = /^#privacy(?:\/[a-z]+(?:\/[A-Za-z0-9_-]{1,128})?)?$/.test(url.hash) ? url.hash : "";
  return (query.size ? "?" + query.toString() : "") + hash;
}

export function adminAccountEntry(url: URL): string {
  const suffix = adminWorkspaceSuffix(url);
  return "/admin?next=/admin" + (suffix ? "#workspace=" + encodeURIComponent(suffix) : "");
}

export function adminWorkspaceReturn(fragment: string): string {
  const values = new URLSearchParams(fragment.replace(/^#/, ""));
  const suffix = values.get("workspace");
  if (values.size !== 1 || !suffix || suffix.length > 6144 || !["?", "#"].includes(suffix[0])) return "/admin";
  return "/admin" + adminWorkspaceSuffix(new URL("/admin" + suffix, "https://portal.example.invalid"));
}
