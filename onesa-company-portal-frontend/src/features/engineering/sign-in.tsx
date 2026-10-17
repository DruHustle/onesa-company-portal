"use client";
import { useEffect, useRef, useState, type FormEvent } from "react";
export function EngineeringSignIn({
  uid,
  environment,
}: {
  uid: string;
  environment: string;
}) {
  const [csrf, setCsrf] = useState(""),
    [phase, setPhase] = useState<"email" | "code">("email"),
    [notice, setNotice] = useState(""),
    [busy, setBusy] = useState(false),
    [ready, setReady] = useState(false);
  const codeInput = useRef<HTMLInputElement>(null);
  useEffect(() => {
    let active = true;
    setReady(false);
    setCsrf("");
    setNotice("");
    const abort = new AbortController();
    fetch("/engineering/sign-in/" + uid + "/details", {
      cache: "no-store",
      signal: abort.signal,
    })
      .then(async (response) => {
        if (!response.ok) throw Error();
        const value = await response.json();
        if (!/^[a-f0-9]{64}$/.test(value.csrf)) throw Error();
        if (active) {
          setCsrf(value.csrf);
          setPhase(value.emailSent ? "code" : "email");
          setReady(true);
        }
      })
      .catch(() => {
        if (active && !abort.signal.aborted)
          setNotice(
            "This sign-in request has expired or is unavailable. Return to Engineering Docs to start again.",
          );
      });
    return () => {
      active = false;
      abort.abort();
    };
  }, [uid]);
  useEffect(() => {
    if (phase === "code") codeInput.current?.focus();
  }, [phase]);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || !ready) return;
    const form = event.currentTarget,
      data = new FormData(form);
    setBusy(true);
    setNotice("");
    try {
      const response = await fetch(
        "/engineering/sign-in/" +
          uid +
          "/" +
          (phase === "email" ? "start" : "verify"),
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            csrf,
            ...(phase === "email"
              ? { email: String(data.get("email")) }
              : { code: String(data.get("code")) }),
          }),
        },
      );
      const value = await response.json();
      if (!response.ok)
        throw Error(
          response.status === 429
            ? "Please wait before trying again."
            : "Sign-in could not be completed. Check your code or return to Engineering Docs to start again.",
        );
      if (phase === "email") {
        setPhase("code");
        form.reset();
      } else {
        if (
          typeof value.continuePath !== "string" ||
          !/^\/api\/v1\/engineering-identity\/auth\/[A-Za-z0-9_-]{8,128}$/.test(
            value.continuePath,
          )
        )
          throw Error("Sign-in could not be completed.");
        window.location.assign(value.continuePath);
      }
    } catch (error) {
      setNotice(
        error instanceof Error
          ? error.message
          : "Sign-in could not be completed.",
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className="admin-main">
      <div className="container">
        <a className="skip-link" href="#engineering-sign-in">
          Skip to sign-in
        </a>
        <section className="admin-login" aria-labelledby="engineering-title">
          <div className="admin-product-title">
            <a href="https://onesa.eu/" aria-label="Onesa company homepage">
              <img
                src="/brand/icons/v1/onesa-company.svg"
                width="48"
                height="48"
                alt="Onesa"
              />
            </a>
            <small>ONESA PORTAL · ENGINEERING DOCS</small>
            <span className="governance-status">
              Protected access · {environment}
            </span>
          </div>
          <h1 id="engineering-title">Sign in to Engineering Docs</h1>
          <p>
            Use your approved email address. We’ll email a one-time code; you
            don’t need a separate Docs password.
          </p>
          <div id="engineering-sign-in">
            {notice && <p role="alert">{notice}</p>}
            {!ready && !notice && (
              <p role="status">Preparing secure sign-in…</p>
            )}
            <form onSubmit={submit} aria-busy={busy}>
              <fieldset disabled={!ready || busy}>
                <legend>
                  {phase === "email"
                    ? "Your approved email"
                    : "Check your email"}
                </legend>
                {phase === "email" ? (
                  <label>
                    Email address
                    <input
                      name="email"
                      type="email"
                      autoComplete="email"
                      maxLength={254}
                      required
                    />
                  </label>
                ) : (
                  <>
                    <p>
                      If your address has approved access, we’ve emailed a code.
                      It expires after 10 minutes and can be used once.
                    </p>
                    <label>
                      Sign-in code
                      <input
                        ref={codeInput}
                        name="code"
                        inputMode="numeric"
                        autoComplete="one-time-code"
                        pattern="[0-9]{6}"
                        minLength={6}
                        maxLength={6}
                        required
                      />
                    </label>
                  </>
                )}
                <button className="button" type="submit">
                  {busy
                    ? "Please wait…"
                    : phase === "email"
                      ? "Email me a sign-in code"
                      : "Verify and open Docs"}
                </button>
              </fieldset>
            </form>
            {phase === "code" && (
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  setPhase("email");
                  setNotice("");
                }}
              >
                Request another code
              </button>
            )}
            <p>
              <a href="/engineering">Return to Engineering Docs</a>
            </p>
            <p>
              Access is granted individually by Onesa.{" "}
              <a href="https://onesa.eu/en/contact">Contact Onesa</a> if you
              need an invitation.
            </p>
          </div>
        </section>
      </div>
    </main>
  );
}
