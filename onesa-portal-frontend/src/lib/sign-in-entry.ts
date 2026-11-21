const engineeringPrompt = /^\/engineering\/sign-in\/([A-Za-z0-9_-]{8,128})$/;
const productPrompt = /^\/account\/sign-in\/([A-Za-z0-9_-]{8,128})$/;

/** Keep existing emailed links and bookmarks usable. Only browser pages move. */
export function legacySignInEntry(path: string, search: URLSearchParams) {
  if (path === "/admin" && ["entry", "docs", "interaction", "next", "returnTo"].some(key => search.has(key))) {
    return "/account?" + search.toString();
  }
  const docs = engineeringPrompt.exec(path);
  if (docs && process.env.ENGINEERING_SIGNIN_ENABLED === "true") return "/account?docs=" + docs[1];
  const product = productPrompt.exec(path);
  return product ? "/account?interaction=" + product[1] : null;
}
