"use client";
import {
  useEffect,
  useRef,
  useState,
  type FocusEvent,
  type FormEvent,
} from "react";
function signature(form: HTMLFormElement) {
  return JSON.stringify(
    [...new FormData(form)]
      .filter(
        ([key]) =>
          !["password", "newPassword", "confirmPassword", "stepUpPassword", "stepUpCode", "code"].includes(key),
      )
      .map(([key, value]) => [
        key,
        typeof value === "string"
          ? value
          : [value.name, value.size, value.lastModified],
      ]),
  );
}
export function useUnsavedWork() {
  const baselines = useRef(new Map<HTMLFormElement, string>()),
    dirtyRef = useRef(false),
    [dirty, setDirty] = useState(false),[draftDirty,setDraftDirty]=useState(false);
  function update() {
    const changed = [...baselines.current].some(
      ([form, initial]) => form.isConnected && signature(form) !== initial,
    );
    dirtyRef.current = changed;
    setDirty(changed);setDraftDirty([...baselines.current].some(([form,initial])=>form.isConnected&&form.hasAttribute("data-editorial-draft")&&signature(form)!==initial));
  }
  function focus(event: FocusEvent<HTMLElement>) {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    const form = target.closest("form");
    if (
      form?.hasAttribute("data-workspace-draft") &&
      !baselines.current.has(form)
    )
      baselines.current.set(form, signature(form));
  }
  // Use React change capture: input capture can restore controlled values before onChange.
  function input(event: FormEvent<HTMLElement>) {
    const target = event.target;
    if (
      !(target instanceof HTMLElement) ||
      !target.closest("form")?.hasAttribute("data-workspace-draft")
    )
      return;
    update();
  }
  function saved(form: HTMLFormElement) {
    baselines.current.set(form, signature(form));
    update();
  }
  function navigate(action: () => void) {
    if (dirtyRef.current) {
      if (
        !window.confirm(
          "You have unsaved changes. Cancel to keep editing and save, or discard these changes to continue.",
        )
      )
        return;
      for (const [form] of baselines.current)
        if (form.isConnected) form.reset();
    }
    baselines.current.clear();
    dirtyRef.current = false;
    setDirty(false);setDraftDirty(false);
    action();
  }
  useEffect(() => {
    const guard = (event: BeforeUnloadEvent) => {
      if (dirtyRef.current) {
        event.preventDefault();
        event.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", guard);
    return () => window.removeEventListener("beforeunload", guard);
  }, []);
  return { dirty, draftDirty, focus, input, saved, navigate };
}
