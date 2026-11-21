/** Test instrumentation only: time the browser click, not driver actionability/transport. */
export function armPublicNavigationTiming({pathname}) {
  const timing={pathname,armedAt:performance.now(),clickedAt:null,readyAt:null,trustedClick:false};
  globalThis.__onesaPublicNavigationTiming=timing;
  const listener=event=>{
    const link=event.target instanceof Element?event.target.closest('a'):null;
    if (!link || !event.isTrusted) return;
    const url=new URL(link.href);
    if(url.origin!==location.origin || url.pathname!==pathname) return;
    timing.clickedAt=performance.now();timing.trustedClick=true;
    document.removeEventListener('click',listener,true);
  };
  document.addEventListener('click',listener,true);
}

export function readPublicNavigationTiming() {
  const timing=globalThis.__onesaPublicNavigationTiming;
  if(!timing || !timing.trustedClick || timing.pathname!==location.pathname
    || ![timing.armedAt,timing.clickedAt,timing.readyAt].every(Number.isFinite)
    || timing.clickedAt<timing.armedAt || timing.readyAt<timing.clickedAt) return null;
  return {...timing,elapsed:timing.readyAt-timing.clickedAt,
    preClick:timing.clickedAt-timing.armedAt};
}

/** One atomic browser observation, retaining every required content predicate. */
export function publicProductShellReady({pathname, measureOnly = false}) {
  if (location.pathname !== pathname) return false;
  const visible = element => !!element && getComputedStyle(element).visibility !== 'hidden'
    && element.getClientRects().length > 0;
  const headingVisible = element => visible(element) && /^H[1-6]$/.test(element.tagName)
    && (!element.getAttribute('role') || element.getAttribute('role') === 'heading')
    && !element.closest('[aria-hidden="true"]');
  const principalHeadings=document.querySelectorAll('main h1');
  if (principalHeadings.length !== 1 || !headingVisible(principalHeadings[0])) return false;
  const markReady=()=>{
    const timing=globalThis.__onesaPublicNavigationTiming;
    if(timing?.pathname===pathname && timing.trustedClick && Number.isFinite(timing.clickedAt)) {
      timing.readyAt??=performance.now();
    }
    return true;
  };
  if (measureOnly) return markReady();
  for (const [id, name] of [['product-ai', 'Onesa AI Platform'], ['product-robot', 'Onesa Robot']]) {
    const heading = document.getElementById(id);
    if (!headingVisible(heading) || heading.textContent.replace(/\s+/g, ' ').trim() !== name) return false;
  }
  const ready=['ai-platform', 'robot'].every(product =>
    document.querySelectorAll(`a[href="https://docs.onesa.eu/docs/public/${product}"]`).length === 1);
  return ready && markReady();
}
