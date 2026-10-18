"use client";
import { useEffect, useState } from "react";
import { api } from "@/lib/api/client";
type Option = { id: string; label: string };
export function RecordPicker({
  kind,
  label,
  name,
  initial,
}: {
  kind: "staff" | "document";
  label: string;
  name: string;
  initial?: string;
}) {
  const [query, setQuery] = useState(""),
    [items, setItems] = useState<Option[]>([]),
    [selected, setSelected] = useState(initial || ""),
    [state, setState] = useState("Loading choices…");
  useEffect(() => {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      setState("Loading choices…");
      const request =
        kind === "staff"
          ? api
              .GET("/api/v1/admin/enquiries/assignees", {
                params: { query: { search: query, limit: 100 } },
                signal: controller.signal,
              })
              .then((r) =>
                r.data!.items.map((item) => ({
                  id: item.id,
                  label: item.email,
                })),
              )
          : api
              .GET("/api/v1/admin/files", {
                params: { query: { search: query, limit: 100 } },
                signal: controller.signal,
              })
              .then((r) =>
                r
                  .data!.items.filter(
                    (item) => item.classification !== "applicant",
                  )
                  .map((item) => ({
                    id: item.id,
                    label: `${item.title} · version ${item.version} · ${item.filename}`,
                  })),
              );
      void request
        .then((options) => {
          if (controller.signal.aborted) return;
          setItems(options);
          setState(
            options.length
              ? ""
              : `No ${kind === "staff" ? "assignable staff" : "documents"} match this search.`,
          );
        })
        .catch(() => {
          if (!controller.signal.aborted)
            setState(
              "Choices could not be loaded. Change the search to retry.",
            );
        });
    }, 200);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [kind, query]);
  return (
    <fieldset>
      <legend>{label}</legend>
      <label>
        Find {kind === "staff" ? "staff by email" : "a document by title"}
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
      </label>
      <label>
        {label}
        <select
          aria-label={label}
          name={name}
          value={selected}
          onChange={(event) => setSelected(event.target.value)}
        >
          <option value="">
            {kind === "staff"
              ? "Unassigned"
              : "New document — no previous version"}
          </option>
          {initial && !items.some((item) => item.id === initial) && (
            <option value={initial}>
              Existing selection — search to verify details
            </option>
          )}
          {items.map((item) => (
            <option value={item.id} key={item.id}>
              {item.label}
            </option>
          ))}
        </select>
      </label>
      {state && <p role="status">{state}</p>}
      {selected && (
        <details>
          <summary>Technical reference</summary>
          <code>{selected}</code>
        </details>
      )}
    </fieldset>
  );
}
