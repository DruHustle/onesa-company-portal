import type {Locale} from '@/config/copy';
import {products} from '@/config/products';
import {ResponsiveLink as Link} from './responsive-link';
import styles from './home-products.module.css';

/** Immediate product discovery; detailed capabilities and documentation stay on Products. */
export function HomeProducts({locale}:{locale:Locale}) {
 const de=locale==='de';
 return <section id="products" className={`section ${styles.section}`} aria-labelledby="home-products-title">
  <div className="section-head">
   <p className="eyebrow">02 / {de?'PRODUKTE':'PRODUCTS'}</p>
   <div><h2 id="home-products-title">{de?'Entdecken Sie, woran wir arbeiten.':'Explore what we’re building.'}</h2>
    <p>{de?'Plattformen und Technologien, die bei Onesa Gestalt annehmen.':'Meet the platforms and technologies taking shape at Onesa.'}</p></div>
  </div>
  <div className={styles.grid}>
   {products[locale].map(product=><article key={product.id}>
    <Link className={styles.card} href={`/${locale}/products#product-${product.id}`} aria-label={`${product.name} — ${de?'Mehr erfahren':'Learn more'}`}>
     <picture>
      <source media="(max-width: 640px)" srcSet={`/images/${product.image}-concept-640.webp`}/>
      <img src={`/images/${product.image}-concept-1280.webp`} width="1280" height="853" loading="lazy" decoding="async" alt={product.imageAlt}/>
     </picture>
     <div className={styles.content}>
      <p className="eyebrow">{product.category}</p>
      <h3>{product.name}</h3><p className={styles.summary}>{product.summary}</p>
      <span className={styles.more}>{de?'Mehr erfahren':'Learn more'} <span aria-hidden="true">↗</span></span>
     </div>
    </Link>
   </article>)}
  </div>
 </section>;
}
