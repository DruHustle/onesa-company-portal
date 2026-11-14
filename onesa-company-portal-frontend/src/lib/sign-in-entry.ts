const engineeringPrompt = /^\/engineering\/sign-in\/([A-Za-z0-9_-]{8,128})$/;
const productPrompt = /^\/account\/sign-in\/([A-Za-z0-9_-]{8,128})$/;

/** Only browser pages move. The provider's per-interaction cookies and action routes keep their paths. */
export function legacySignInEntry(path: string, search: URLSearchParams) {
  if (path === "/account") {
    const query = new URLSearchParams(search);
    query.delete("entry");
    if (!["docs", "interaction", "returnTo", "next"].some(key => query.has(key))) query.set("entry", "account");
    return "/admin?" + query.toString();
  }
  const docs = engineeringPrompt.exec(path);
  if (docs && process.env.ENGINEERING_SIGNIN_ENABLED === "true") return "/admin?docs=" + docs[1];
  const product = productPrompt.exec(path);
  if (product) return "/admin?interaction=" + product[1];
  return null;
}
