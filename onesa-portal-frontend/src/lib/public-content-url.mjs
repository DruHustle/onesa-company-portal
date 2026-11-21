export const companySections = ['about','products','technology','industries','research','partnerships','careers','news','contact','impressum','privacy','cookies','accessibility'];
/** @type {Record<string,string>} */
const detailSections = {product:'products',article:'news',job:'careers',research:'research'};

/** Emit only routes implemented by the public router. */
/** @param {{kind:string,locale:string,slug:string}} item */
export function publicContentPath(item) {
  if (!['en','de'].includes(item.locale) || !/^[a-z0-9-]+$/.test(item.slug)) return null;
  const section = Object.hasOwn(detailSections,item.kind) ? detailSections[item.kind] : null;
  if (section) return `/${item.locale}/${section}/${item.slug}`;
  if (item.kind !== 'page' && item.kind !== 'section') return null;
  if (item.slug === 'homepage') return item.locale === 'en' ? '/' : '/de';
  return companySections.includes(item.slug) ? `/${item.locale}/${item.slug}` : null;
}
