/** History contains a position only, never draft content or credentials. */
export function protectDraftHistory(allow: () => boolean) {
  const key = "__onesaDraftPosition",
    history = window.history;
  const push = history.pushState,
    replace = history.replaceState;
  let position = Number.isSafeInteger(history.state?.[key])
    ? history.state[key]
    : 0;
  let location = window.location.href, restoring = false;
  const blockedHashEvents = new Set<string>();
  let deciding = false;
  const deferredHash: HashChangeEvent[] = [];
  const positions = new Map<string, number>([[location, position]]);
  const tagged = (state: unknown, index: number) => ({
    ...(state && typeof state === "object" ? state : {}),
    [key]: index,
  });
  replace.call(history, tagged(history.state, position), "", location);
  const trackedPush: History["pushState"] = function (state, unused, url) {
    blockedHashEvents.clear();
    push.call(history, tagged(state, position + 1), unused, url);
    position += 1;
    location = window.location.href;
    positions.set(location, position);
  };
  const trackedReplace: History["replaceState"] = function (
    state,
    unused,
    url,
  ) {
    replace.call(history, tagged(state, position), unused, url);
    location = window.location.href;
    positions.set(location, position);
  };
  history.pushState = trackedPush;
  history.replaceState = trackedReplace;
  function popped(event: PopStateEvent) {
    if (restoring) {
      event.stopImmediatePropagation();
      restoring = false;
      return;
    }
    const target = Number.isSafeInteger(event.state?.[key])
      ? event.state[key]
      : positions.get(window.location.href);
    blockedHashEvents.clear(); deferredHash.length = 0;
    if (new URL(location).hash !== new URL(window.location.href).hash) {
      blockedHashEvents.add(location); blockedHashEvents.add(window.location.href);
    }
    // A native confirmation may run a nested event loop. Protect the hash
    // before asking, otherwise Firefox can unmount the editor during the prompt.
    deciding = true;
    const permitted = allow();
    deciding = false;
    if (!permitted) {
      event.stopImmediatePropagation();
      restoring = true;
      // App-created entries have exact indices. Older untagged entries reached
      // by Back are restored without overwriting their URL or Next router state.
      history.go(target === undefined ? 1 : position - target);
      return;
    }
    blockedHashEvents.clear();
    position = target ?? position - 1;
    location = window.location.href;
    replace.call(history, tagged(history.state, position), "", location);
    const replay = deferredHash.pop();
    if (replay) window.dispatchEvent(new HashChangeEvent("hashchange", {oldURL: replay.oldURL, newURL: replay.newURL}));
  }
  function hashChanged(event: HashChangeEvent) {
    if (deciding) {
      event.stopImmediatePropagation(); deferredHash.push(event);
      blockedHashEvents.delete(event.newURL); return;
    }
    if (restoring || blockedHashEvents.has(event.newURL)) {
      event.stopImmediatePropagation();
      blockedHashEvents.delete(event.newURL);
    }
  }
  window.addEventListener("popstate", popped, true);
  window.addEventListener("hashchange", hashChanged, true);
  return () => {
    window.removeEventListener("popstate", popped, true);
    window.removeEventListener("hashchange", hashChanged, true);
    if (history.pushState === trackedPush) history.pushState = push;
    if (history.replaceState === trackedReplace) history.replaceState = replace;
  };
}
