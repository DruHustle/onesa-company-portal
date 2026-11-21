'use client';

import {useEffect} from 'react';
import {usePathname} from 'next/navigation';

/** Restore topic bookmarks after the streamed page has hydrated. */
export function TechnologyTopicAnchor() {
  const pathname = usePathname();
  useEffect(() => {
    const scrollToTopic = () => {
      const id = window.location.hash.slice(1);
      if (!id) return;
      const heading = document.getElementById(id);
      if (!heading?.matches('.technology-capabilities h2')) return;
      heading.scrollIntoView({block:'start', behavior:'instant'});
      heading.focus({preventScroll:true});
    };
    let frame = 0;
    const settleTopic = () => {
      cancelAnimationFrame(frame);
      // WebKit may restore history after hydration/pageshow. Align after that paint.
      frame = requestAnimationFrame(() => {
        frame = requestAnimationFrame(scrollToTopic);
      });
    };
    const onPageShow = (event: PageTransitionEvent) => {
      // A cached Back navigation keeps the reader's own restored position.
      if (!event.persisted) settleTopic();
    };
    scrollToTopic();
    if (document.readyState === 'complete') settleTopic();
    else window.addEventListener('load', settleTopic, {once:true});
    window.addEventListener('pageshow', onPageShow);
    window.addEventListener('hashchange', settleTopic);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener('load', settleTopic);
      window.removeEventListener('pageshow', onPageShow);
      window.removeEventListener('hashchange', settleTopic);
    };
  }, [pathname]);
  return null;
}
