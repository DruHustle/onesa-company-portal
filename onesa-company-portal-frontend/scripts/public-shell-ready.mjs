/** One atomic browser observation; no automation round trips inside the timing predicate. */
export function publicProductShellReady({pathname, measureOnly = false}) {
  if (location.pathname !== pathname) return false;
  const visible = element => !!element && getComputedStyle(element).visibility !== 'hidden'
    && element.getClientRects().length > 0;
  const headingVisible = element => visible(element) && /^H[1-6]$/.test(element.tagName)
    && (!element.getAttribute('role') || element.getAttribute('role') === 'heading')
    && !element.closest('[aria-hidden="true"]');
  const principalHeadings=document.querySelectorAll('main h1');
  if (principalHeadings.length !== 1 || !headingVisible(principalHeadings[0])) return false;
  if (measureOnly) return true;
  for (const [id, name] of [['product-ai', 'Onesa AI Platform'], ['product-robot', 'Onesa AI Robot']]) {
    const heading = document.getElementById(id);
    if (!headingVisible(heading) || heading.textContent.replace(/\s+/g, ' ').trim() !== name) return false;
  }
  return ['ai-platform', 'robot'].every(product =>
    document.querySelectorAll(`a[href="https://docs.onesa.eu/docs/public/${product}"]`).length === 1);
}
