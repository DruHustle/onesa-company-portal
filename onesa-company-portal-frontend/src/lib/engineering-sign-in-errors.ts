export type EngineeringSignInAction = "details" | "link" | "password" | "link-verify" | "handoff-verify";

/** Describe only the state reported by the server; a failed login does not prove registration status. */
export function engineeringSignInError(status: number, code: unknown, action: EngineeringSignInAction) {
  if (code === "ENGINEERING_INTERACTION") return {
    message: "This sign-in request is no longer active in this browser. Open your latest email link again, or start a new sign-in.", restart: true, registration: false,
  };
  if (typeof code === "string" && ["ENGINEERING_PROOF", "ORIGIN", "ENGINEERING_PROXY", "ENGINEERING_PROTOCOL", "FILE_SIZE"].includes(code)) return {
    message: "This sign-in page could not be verified. Start a new sign-in from Engineering Docs.", restart: true, registration: false,
  };
  if (code === "ENGINEERING_REGISTRATION_REQUIRED" && action === "password") return {
    message: "Complete Engineering Docs registration to set up password sign-in, or choose an emailed sign-in link.", restart: false, registration: true,
  };
  if (code === "ENGINEERING_APPROVAL_PENDING" && action === "password") return {
    message: "Your registration is awaiting owner approval. You can sign in after it is approved.", restart: false, registration: false,
  };
  if (status === 429) return {
    message: "Too many sign-in attempts. Please wait before trying again.", restart: false, registration: false,
  };
  if (status >= 500 || code === "ENGINEERING_SIGN_IN_UNAVAILABLE") return {
    message: "The sign-in service is temporarily unavailable. Please try again shortly.", restart: false, registration: false,
  };
  if (action === "password") return {
    message: "Email or password is incorrect. Use your Engineering Docs password, or choose an emailed sign-in link.", restart: false, registration: false,
  };
  if (code === "ACCESS_LINK" || action === "link-verify" || action === "handoff-verify") return {
    message: "This sign-in link is invalid, expired or already used. Start again to request a new link.", restart: true, registration: false,
  };
  return {
    message: "This sign-in request could not be verified. Start a new sign-in from Engineering Docs.", restart: true, registration: false,
  };
}
