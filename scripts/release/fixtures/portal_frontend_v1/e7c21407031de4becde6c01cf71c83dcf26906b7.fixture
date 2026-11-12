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
  if (productInteractionPath.test(values[0])) return values[0];
  if (engineeringPath.test(values[0])) return "/account?returnTo=" + encodeURIComponent(values[0]) + "&reauthenticate=1";
  return "/account";
}

/** No arbitrary origin, query, fragment or product callback is accepted here. */
export function engineeringAccountSignInPath(uid: string): string | null {
  return interactionId.test(uid) ? "/account?returnTo=" + encodeURIComponent("/engineering/sign-in/" + uid) : null;
}
