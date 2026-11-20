import {ResponsiveLink as Link} from '@/components/responsive-link';
import {technologyTopics} from '@/config/technology';
import type {Locale} from '@/config/copy';

export function TechnologyTopic({locale,topic}:{locale:Locale;topic:ReturnType<typeof technologyTopics>[number]}) {
  const de=locale==='de';
  return <main id="main" data-technology-topic={topic.id}>
    <section className="page-hero section">
      <p className="eyebrow"><Link href={`/${locale}/technology`}>{de?'ONESA UG / TECHNOLOGIE':'ONESA UG / TECHNOLOGY'}</Link></p>
      <h1>{topic.title}</h1>
    </section>
    <section className="section page-content">
      <article className="prose" aria-label={topic.title}>
        <h2>{de?'Unser Ansatz':'Our approach'}</h2>
        <p>{topic.introduction}</p><p>{topic.detail}</p>
      </article>
      <nav className="admin-actions" aria-label={de?'Nächste Schritte':'Next steps'}>
        <Link href={`/${locale}/technology`}>{de?'Alle technischen Kompetenzen':'All engineering capabilities'}</Link>
        <Link href={`/${locale}/contact`}>{de?'Ein Projekt besprechen':'Discuss a project'}</Link>
        <a href="https://docs.onesa.eu/">{de?'Öffentliche Dokumentation':'Public documentation'}</a>
      </nav>
    </section>
  </main>;
}
