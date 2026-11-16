export type AccountLanguage = "en" | "de";

/** Keep outage guidance aligned with Onesa Identity as the sole global account authority. */
export function accountUnavailableHint(language: AccountLanguage): string {
  return language === "de"
    ? "Die Onesa-Anmeldung ist vorübergehend nicht verfügbar. Bitte versuchen Sie es erneut. Wenn das Problem weiterhin besteht, wenden Sie sich an Ihre Administration. Erstellen Sie kein weiteres Konto."
    : "Onesa sign-in is temporarily unavailable. Please retry. If the problem continues, contact your administrator. Do not create another account.";
}
