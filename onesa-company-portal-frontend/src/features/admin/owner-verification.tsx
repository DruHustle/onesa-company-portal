"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { ApiError } from "@/lib/api/client";
import { submitOwnerOperation, verifiedPopupMessage, type OwnerProof } from "@/lib/managed-operation";

type Pending = {
  challenge: string;
  resolve: () => void;
  reject: (error: Error) => void;
  popup: Window | null;
};
const VerificationContext = createContext<{ managed: boolean; verify: (challenge: string) => Promise<void> } | null>(null);

export function OwnerVerification({ managed, children }: { managed: boolean; children: ReactNode }) {
  const current = useRef<Pending | null>(null);
  const mounted = useRef(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [windowState, setWindowState] = useState<"ready" | "open" | "blocked">("ready");

  const finish = useCallback((error?: Error) => {
    const item = current.current;
    if (!item) return;
    current.current = null;
    item.popup?.close();
    if (mounted.current) setPending(null);
    if (error) item.reject(error);
    else item.resolve();
  }, []);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      finish(new Error("Verification was cancelled."));
    };
  }, [finish]);

  const verify = useCallback((challenge: string) => new Promise<void>((resolve, reject) => {
    if (!mounted.current || current.current) {
      reject(new Error("The verification window is unavailable. Submit the change again."));
      return;
    }
    current.current = { challenge, resolve, reject, popup: null };
    setWindowState("ready");
    setPending(current.current);
  }), []);

  useEffect(() => {
    if (!pending) return;
    const item = pending;
    const element = dialog.current!;
    element.showModal();
    function received(event: MessageEvent) {
      if (current.current === item && verifiedPopupMessage(event, item.popup, window.location.origin)) finish();
    }
    window.addEventListener("message", received);
    const timeout = window.setTimeout(() => {
      if (current.current === item) finish(new Error("Verification expired. Submit the change again."));
    }, 5 * 60_000);
    return () => {
      window.clearTimeout(timeout);
      window.removeEventListener("message", received);
      element.close();
    };
  }, [pending, finish]);

  function openVerification() {
    const item = current.current;
    if (!item) return;
    const url = "/api/v1/auth/managed/step-up?challenge=" + encodeURIComponent(item.challenge);
    // Open only from the button's click so browser popup policies preserve the form.
    item.popup = window.open(url, "_blank", "popup,width=560,height=740");
    setWindowState(item.popup ? "open" : "blocked");
  }

  return <VerificationContext.Provider value={{ managed, verify }}>
    {children}
    {pending && <dialog ref={dialog} aria-labelledby="owner-verification-title"
      onCancel={event => { event.preventDefault(); finish(new Error("Verification was cancelled.")); }}>
      <h2 id="owner-verification-title">Confirm this change with Onesa</h2>
      {windowState === "open" ? <>
        <p>Complete verification in the Onesa window. If you have finished and this dialog is still open, continue below.</p>
        <button type="button" className="button" onClick={() => finish()}>I completed verification</button>
      </> : <>
        <p role="status">{windowState === "blocked" ? "Your browser blocked the verification window. Open verification in a new tab or allow pop-ups and try again." : "Verify your identity in a separate window to submit this change."}</p>
        <button type="button" className="button" onClick={openVerification}>Verify with Onesa</button>
      </>}
      {windowState === "blocked" && <a href={"/api/v1/auth/managed/step-up?challenge=" + encodeURIComponent(pending.challenge)}
        target="_blank" rel="noopener noreferrer" onClick={() => setWindowState("open")}>Open verification in a new tab</a>}
      <button type="button" onClick={() => finish(new Error("Verification was cancelled."))}>Cancel</button>
    </dialog>}
  </VerificationContext.Provider>;
}

export function useOwnerVerification() {
  const context = useContext(VerificationContext);
  if (!context) throw new Error("Owner verification is unavailable.");
  const { managed, verify } = context;
  function submit<T extends object, R>(data: FormData, body: T, send: (input: T & { stepUp: OwnerProof }) => Promise<R>) {
    const proof: OwnerProof = managed ? { managed: true } : { password: String(data.get("password") ?? ""), code: String(data.get("code") ?? "") };
    return submitOwnerOperation(body, proof, send, failure => failure instanceof ApiError && failure.status === 403 &&
      failure.code === "PROVIDER_STEP_UP_REQUIRED" ? failure.challenge ?? null : null, verify);
  }
  return { managed, submit };
}
