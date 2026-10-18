"use client";
import { useEffect, useState, type FormEvent } from "react";
import { api } from "@/lib/api/client";
import type { operations } from "@/lib/api/generated/schema";
type Member =
  operations["listEngineeringMemberships"]["responses"][200]["content"]["application/json"]["items"][number];
export function EngineeringMemberships() {
  const [items, setItems] = useState<Member[]>([]),
    [selected, setSelected] = useState<Member | null>(null),
    [configured, setConfigured] = useState(false),
    [ready, setReady] = useState(false),
    [busy, setBusy] = useState(false),
    [notice, setNotice] = useState("");
  async function load() {
    const response = await api.GET("/api/v1/admin/engineering/memberships");
    setItems(response.data!.items);
    setConfigured(response.data!.configured);
    setReady(true);
  }
  useEffect(() => {
    let active = true;
    api
      .GET("/api/v1/admin/engineering/memberships")
      .then((response) => {
        if (active) {
          setItems(response.data!.items);
          setConfigured(response.data!.configured);
          setReady(true);
        }
      })
      .catch(() => {
        if (active)
          setNotice("Engineering memberships could not be loaded. Try again.");
      });
    return () => {
      active = false;
    };
  }, []);
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || !ready) return;
    const form = event.currentTarget,
      data = new FormData(form);
    setBusy(true);
    setNotice("");
    try {
      await api.PUT("/api/v1/admin/engineering/memberships", {
        body: {
          email: String(data.get("email")),
          enabled: data.get("enabled") === "on",
          evidence: String(data.get("evidence")),
          expectedRevision: selected?.revision ?? 0,
          password: String(data.get("password")),
          code: String(data.get("code")),
        },
      });
      form.reset();
      setSelected(null);
      await load();
      setNotice(
        "Membership saved. Existing Docs sessions require separate access-session revocation when offboarding.",
      );
    } catch (error) {
      setNotice(
        error instanceof Error
          ? error.message
          : "Membership could not be saved.",
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <section aria-labelledby="engineering-memberships-title">
      <h2 id="engineering-memberships-title">Engineering Docs access</h2>
      <p>
        Onboard individual approved Onesa email addresses without granting
        Portal administration. Engineers sign in with an Onesa emailed sign-in link or their registered email and password. Existing
        approved external members can be retained.
      </p>
      <p>
        <a href="https://docs.engineering.onesa.eu/">Open protected Engineering Docs ↗</a>. First update the exact-email Docs access policy using the protected
        onboarding procedure. Record its verification reference here. A
        membership alone cannot bypass that policy. Disabling membership
        prevents new Portal sign-ins; revoke existing Docs access sessions
        separately.
      </p>
      {notice && <p role="status">{notice}</p>}
      {!ready && (
        <button
          type="button"
          disabled={busy}
          onClick={() =>
            void load().catch(() =>
              setNotice("Engineering memberships could not be loaded."),
            )
          }
        >
          Retry loading memberships
        </button>
      )}
      {ready && !configured && (
        <p>
          Portal-based Engineering sign-in is not configured in this
          environment.
        </p>
      )}
      <div className="admin-grid">
        <div className="admin-list">
          <button
            type="button"
            disabled={busy}
            onClick={() => setSelected(null)}
          >
            Add approved engineer
          </button>
          {items.map((item) => (
            <button
              type="button"
              disabled={busy}
              key={item.id}
              onClick={() => setSelected(item)}
              aria-pressed={selected?.id === item.id}
            >
              {item.email}
              <small>
                {item.enabled ? "Enabled" : "Disabled"} · Revision{" "}
                {item.revision}
              </small>
            </button>
          ))}
        </div>
        <form
          className="admin-card"
          key={selected?.id ?? "new-engineer"}
          onSubmit={save}
          aria-busy={busy}
        >
          <fieldset disabled={busy || !ready}>
            <legend>
              {selected
                ? "Edit engineering membership"
                : "New engineering membership"}
            </legend>
            <label>
              Approved individual email
              <input
                name="email"
                type="email"
                autoComplete="off"
                required
                maxLength={254}
                defaultValue={selected?.email ?? ""}
                readOnly={selected !== null}
              />
            </label>
            <label className="check">
              <input
                name="enabled"
                type="checkbox"
                defaultChecked={selected?.enabled ?? false}
                disabled={!configured}
              />
              Enable new Engineering sign-ins
            </label>
            <label>
              Exact-email access-policy verification reference
              <textarea
                name="evidence"
                required
                minLength={10}
                maxLength={2000}
                defaultValue={selected?.access_policy_evidence ?? ""}
              />
            </label>
            <p>
              Confirm your owner credentials. A code already used for sign-in
              cannot be reused.
            </p>
            <label>
              Owner password for this membership change
              <input
                name="password"
                type="password"
                autoComplete="current-password"
                required
              />
            </label>
            <label>
              Owner authenticator or recovery code for this membership change
              <input
                name="code"
                autoComplete="one-time-code"
                required
                minLength={6}
                maxLength={64}
              />
            </label>
            <button className="button" disabled={busy || !ready}>
              {busy ? "Saving…" : "Save membership"}
            </button>
          </fieldset>
        </form>
      </div>
    </section>
  );
}
