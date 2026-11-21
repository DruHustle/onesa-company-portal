"use client";
import { useEffect, useState } from "react";
import { api, ApiError } from "@/lib/api/client";
import type { operations } from "@/lib/api/generated/schema";
type Overview = operations["infrastructureOverview"]["responses"][200]["content"]["application/json"];
const statusLabels = { available: "Available", unavailable: "Unavailable", stale: "Stale observation", not_observed: "Not observed" };
export function Infrastructure() {
  const [overview, setOverview] = useState<Overview | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(true);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setBusy(true); setError("");
    void api.GET("/api/v1/admin/infrastructure", { signal: controller.signal })
      .then(result => { if (!controller.signal.aborted) setOverview(result.data!); })
      .catch(reason => { if (!controller.signal.aborted) { setOverview(null); setError(reason instanceof ApiError ? reason.message : "Infrastructure observations are unavailable. Try again."); } })
      .finally(() => { if (!controller.signal.aborted) setBusy(false); });
    const timer = setTimeout(() => setAttempt(value => value + 1), 30000);
    return () => { controller.abort(); clearTimeout(timer); };
  }, [attempt]);
  return <section aria-label="Infrastructure observations" aria-busy={busy}>
    <p>Products, hosting and their latest operational observations. Observations older than five minutes are marked stale.</p>
    <button disabled={busy} onClick={() => setAttempt(value => value + 1)}>Refresh observations</button>
    {busy && <p role="status">Loading infrastructure observations…</p>}
    {error && <p role="alert">{error}</p>}
    {overview && <>
      {overview.observationState !== "loaded" && <p role="status">No current monitoring snapshot is available. Service health has not been established.</p>}
      <p>Last checked: <time dateTime={overview.checkedAt}>{new Date(overview.checkedAt).toLocaleString()}</time></p>
      <div className="infrastructure-services">{overview.services.map(service => <article className="admin-card" key={service.id}>
        <h3>{service.name}</h3><strong>{statusLabels[service.status]}</strong>
        <p>{service.hosting}</p><p>Dependencies: {service.dependencies.join(", ")}</p>
        <p>{service.observedAt ? <>Observed <time dateTime={service.observedAt}>{new Date(service.observedAt).toLocaleString()}</time> · {service.environment}</> : "No runtime observation recorded"}</p>
        {service.status === "stale" && service.lastObservedState && <p>Previous result: {statusLabels[service.lastObservedState]}</p>}
        <p>{service.scope}</p>
        {service.revision && <p>Observed revision: <code>{service.revision.slice(0, 12)}</code></p>}
        <a href={service.url} target="_blank" rel="noopener noreferrer">Open {service.name === "Kubernetes" || service.name === "Portainer" ? "protected operations guide" : service.name}</a>
      </article>)}</div>
    </>}
  </section>;
}
