// Only the isolated public-product fixture uses this observer. It supplies no
// application behavior and never changes an action, its timeout or its result.
const kinds = new Set(['document_ready', 'scroll', 'gallery', 'pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click', 'toggle']);
const states = new Set(['loading', 'ready', 'failed', 'unavailable', 'other']);
const keys = ['box', 'canvas_count', 'details_open', 'kind', 'page_ms', 'point', 'renderer_state', 'scroll_y'];
const finite = value => typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= 1e6;
const tuple = (value, length) => Array.isArray(value) && value.length === length && value.every(finite);
const copy = value => value === null ? null : {...value, box: [...value.box], point: value.point === null ? null : [...value.point]};
const cap = value => Math.min(value, 1e6);

export function createInteractionRecorder(clock = () => performance.now()) {
  const started = clock(), events = [];
  let dropped = 0, rejected = 0, beforeCommand = null, commandMs = null;
  const elapsed = () => Math.round(Math.max(0, Math.min(1e6, clock() - started)));
  return {
    observe(value) {
      if (!value || typeof value !== 'object' || Array.isArray(value)
        || Object.keys(value).sort().join(',') !== keys.join(',')
        || !kinds.has(value.kind) || !states.has(value.renderer_state)
        || typeof value.details_open !== 'boolean' || !Number.isInteger(value.canvas_count)
        || value.canvas_count < 0 || value.canvas_count > 8
        || !finite(value.page_ms) || value.page_ms < 0 || !finite(value.scroll_y)
        || !tuple(value.box, 4) || value.box[2] < 0 || value.box[3] < 0
        || (value.point !== null && !tuple(value.point, 2))) {
        rejected = cap(rejected + 1); return;
      }
      const event = {...copy(value), observed_ms: elapsed()};
      if (events.length === 16) {events.shift(); dropped = cap(dropped + 1);}
      events.push(event);
    },
    beforeCommand() {
      commandMs = elapsed();
      beforeCommand = copy(events.at(-1) ?? null);
    },
    snapshot() {
      return {command_ms: commandMs, before_command: copy(beforeCommand), events: events.map(copy), dropped, rejected};
    },
  };
}

export function recordSyntheticPageObservation(source, page, recorder, value) {
  try {
    const url = new URL(source.frame.url());
    if (source.page === page && source.frame === page.mainFrame()
      && url.origin === 'http://127.0.0.1:3348' && !url.search && !url.hash
      && ['/en/products/onesa-drone', '/de/products/onesa-drone'].includes(url.pathname)) recorder.observe(value);
  } catch { /* A missing or foreign frame is not a diagnostic source. */ }
}

// Serialized into a fresh synthetic page before navigation. No timers, waits,
// animation loop, DOM writes, storage or network calls are introduced. At most
// 16 passive and 16 native-input samples read geometry per document. Passive
// scroll/gallery bursts are sampled no more often than once per 50 ms.
export function installAircraftInteractionObserver() {
  if (window !== window.top || location.origin !== 'http://127.0.0.1:3348'
    || !['/en/products/onesa-drone', '/de/products/onesa-drone'].includes(location.pathname)
    || location.search || location.hash) return;
  const binding = '__onesaDroneProductObservation';
  const nativeKinds = ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click', 'toggle'];
  const options = {capture: true, passive: true};
  let passiveSamples = 0, inputSamples = 0, lastPassive = -Infinity, galleryObserver;
  const bounded = value => Number.isFinite(value) ? Math.round(Math.max(-1e6, Math.min(1e6, value)) * 100) / 100 : 0;
  const summary = () => document.querySelector('main details svg[role="img"]')?.closest('details')?.querySelector(':scope > summary');
  const stopPassive = () => {window.removeEventListener('scroll', scroll, options); galleryObserver?.disconnect();};
  function sample(kind, event) {
    const input = nativeKinds.includes(kind), now = performance.now();
    if (input ? inputSamples >= 16 : passiveSamples >= 16 || now - lastPassive < 50) return;
    // A failed or inapplicable optional read still consumes its attempt. Remove
    // listeners at the limit before entering DOM work that can throw.
    if (input) {
      inputSamples++;
      if (inputSamples === 16) for (const name of nativeKinds) document.removeEventListener(name, native, options);
    } else {
      passiveSamples++; lastPassive = now;
      if (passiveSamples === 16) stopPassive();
    }
    try {
      const node = summary(); if (!node) return;
      if (input && (event.type === 'toggle' ? event.target !== node.parentElement
        : !(event.target instanceof Element) || event.target.closest('summary') !== node)) return;
      const gallery = document.querySelector('#nvidia-environments'), state = gallery?.getAttribute('data-state');
      const box = node.getBoundingClientRect();
      const value = {kind, page_ms: Math.max(0, bounded(now)),
        renderer_state: ['loading', 'ready', 'failed', 'unavailable'].includes(state) ? state : 'other',
        details_open: node.parentElement.open === true,
        canvas_count: Math.min(gallery?.querySelectorAll('canvas').length ?? 0, 8),
        scroll_y: bounded(window.scrollY), box: [box.left, box.top, box.width, box.height].map(bounded),
        point: event && Number.isFinite(event.clientX) && Number.isFinite(event.clientY) ? [bounded(event.clientX), bounded(event.clientY)] : null};
      const deliver = window[binding];
      if (typeof deliver === 'function') void Promise.resolve(deliver(value)).catch(() => {});
    } catch { /* Optional observation cannot affect the interaction under test. */ }
  }
  function native(event) {sample(event.type, event);}
  function scroll() {sample('scroll');}
  function ready() {
    sample('document_ready');
    const gallery = document.querySelector('#nvidia-environments');
    if (gallery && passiveSamples < 16) {
      galleryObserver = new MutationObserver(() => sample('gallery'));
      galleryObserver.observe(gallery, {attributes: true, attributeFilter: ['data-state'], childList: true, subtree: true});
    }
  }
  for (const name of nativeKinds) document.addEventListener(name, native, options);
  window.addEventListener('scroll', scroll, options);
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', ready, {once: true});
  else ready();
}
