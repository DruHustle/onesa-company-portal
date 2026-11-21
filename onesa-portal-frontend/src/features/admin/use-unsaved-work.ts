"use client";
import {
  createContext,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type FocusEvent,
  type FormEvent,
} from "react";
import { protectDraftHistory } from "./draft-history";
function signature(form: HTMLFormElement) {
  // A pending-request fieldset disables submission, not the underlying draft.
  // FormData would omit these controls and create a false dirty/clean transition.
  const values: unknown[] = [];
  for (const control of form.elements) {
    if (
      !(
        control instanceof HTMLInputElement ||
        control instanceof HTMLSelectElement ||
        control instanceof HTMLTextAreaElement
      ) ||
      !control.name ||
      [
        "password",
        "newPassword",
        "confirmPassword",
        "stepUpPassword",
        "stepUpCode",
        "code",
      ].includes(control.name)
    )
      continue;
    if (
      control instanceof HTMLInputElement &&
      ["checkbox", "radio"].includes(control.type) &&
      !control.checked
    )
      continue;
    const value =
      control instanceof HTMLInputElement && control.type === "file"
        ? [...(control.files || [])].map((file) => [
            file.name,
            file.size,
            file.lastModified,
          ])
        : control instanceof HTMLSelectElement && control.multiple
          ? [...control.selectedOptions].map((option) => option.value)
          : control.value;
    values.push([control.name, value]);
  }
  return JSON.stringify(values);
}
type Draft = { dirty: () => boolean; discard: () => void };
function makeController(
  render: (state: {
    dirty: boolean;
    draftDirty: boolean;
    pending: boolean;
  }) => void,
) {
  const forms = new Map<HTMLFormElement, string>(),
    drafts = new Map<string, Draft>();
  let operations = 0;
  function state() {
    for (const form of forms.keys()) if (!form.isConnected) forms.delete(form);
    const changed = [...forms].filter(
      ([form, initial]) => signature(form) !== initial,
    );
    return {
      dirty: changed.length > 0 || [...drafts.values()].some((d) => d.dirty()),
      draftDirty: changed.some(([form]) =>
        form.hasAttribute("data-editorial-draft"),
      ),
      pending: operations > 0,
    };
  }
  const notify = () => render(state());
  function allow() {
    if (operations) {
      window.alert(
        "A request is still in progress. Wait for its result before leaving this task.",
      );
      return false;
    }
    if (
      state().dirty &&
      !window.confirm(
        "You have unsaved changes. Choose Cancel to stay and keep editing, or OK to discard them and leave.",
      )
    )
      return false;
    for (const [form, initial] of forms)
      if (form.isConnected && signature(form) !== initial) form.reset();
    for (const draft of drafts.values()) if (draft.dirty()) draft.discard();
    forms.clear();
    notify();
    return true;
  }
  return {
    notify,
    state,
    allow,
    navigate(action: () => void) {
      if (allow()) action();
    },
    register(id: string, draft: Draft) {
      drafts.set(id, draft);
      notify();
      return () => {
        drafts.delete(id);
        notify();
      };
    },
    beginMutation() {
      operations += 1;
      notify();
      let ended = false;
      return () => {
        if (!ended) {
          ended = true;
          operations -= 1;
          notify();
        }
      };
    },
    focus(event: FocusEvent<HTMLElement>) {
      const form =
        event.target instanceof HTMLElement
          ? event.target.closest("form[data-workspace-draft]")
          : null;
      if (form instanceof HTMLFormElement && !forms.has(form))
        forms.set(form, signature(form));
    },
    input(event: FormEvent<HTMLElement>) {
      if (
        event.target instanceof HTMLElement &&
        event.target.closest("form[data-workspace-draft]")
      )
        notify();
    },
    saved(form: HTMLFormElement) {
      if (form.isConnected) forms.set(form, signature(form));
      notify();
    },
  };
}
export type WorkspaceGuard = ReturnType<typeof makeController>;
export const WorkspaceDraftContext = createContext<WorkspaceGuard | null>(null);
export function useWorkspaceGuard() {
  const guard = useContext(WorkspaceDraftContext);
  if (!guard) throw new Error("Workspace draft protection is required");
  return guard;
}
/** Controlled state is compared directly; unnamed fields are included. */
export function useWorkspaceDraft<T>(value: T, discard: () => void) {
  const guard = useWorkspaceGuard(),
    id = useId();
  const current = useRef(JSON.stringify(value)),
    initial = useRef(current.current),
    reset = useRef(discard);
  current.current = JSON.stringify(value);
  reset.current = discard;
  useLayoutEffect(
    () =>
      guard.register(id, {
        dirty: () => current.current !== initial.current,
        discard: () => {
          current.current = initial.current;
          reset.current();
        },
      }),
    [guard, id],
  );
  useLayoutEffect(() => guard.notify(), [guard, value]);
  return {
    saved() {
      initial.current = current.current;
      guard.notify();
    },
  };
}
export function useWorkspaceMutation() {
  const guard = useWorkspaceGuard(),
    active = useRef<null | (() => void)>(null);
  useEffect(() => () => active.current?.(), []);
  return {
    start() {
      if (active.current) return null;
      const end = guard.beginMutation();
      const release = () => {
        end();
        active.current = null;
      };
      active.current = release;
      return release;
    },
  };
}
export function useUnsavedWork() {
  const [view, setView] = useState({
    dirty: false,
    draftDirty: false,
    pending: false,
  });
  const controller = useMemo(
    () =>
      makeController((next) =>
        setView((old) =>
          old.dirty === next.dirty &&
          old.draftDirty === next.draftDirty &&
          old.pending === next.pending
            ? old
            : next,
        ),
      ),
    [],
  );
  useEffect(() => {
    const guard = (event: BeforeUnloadEvent) => {
      const s = controller.state();
      if (s.dirty || s.pending) {
        event.preventDefault();
        event.returnValue = "";
      }
    };
    const click = (event: MouseEvent) => {
      if (
        event.defaultPrevented ||
        event.button ||
        event.metaKey ||
        event.ctrlKey ||
        event.shiftKey ||
        event.altKey
      )
        return;
      const link =
        event.target instanceof Element
          ? event.target.closest("a[href]")
          : null;
      if (
        !(link instanceof HTMLAnchorElement) ||
        link.target === "_blank" ||
        link.hasAttribute("download") ||
        !/^https?:$/.test(link.protocol)
      )
        return;
      if (
        (controller.state().dirty || controller.state().pending) &&
        !controller.allow()
      ) {
        event.preventDefault();
        event.stopImmediatePropagation();
      }
    };
    const cleanup = protectDraftHistory(controller.allow);
    window.addEventListener("beforeunload", guard);
    document.addEventListener("click", click, true);
    return () => {
      cleanup();
      window.removeEventListener("beforeunload", guard);
      document.removeEventListener("click", click, true);
    };
  }, [controller]);
  return { ...controller, ...view, controller };
}
