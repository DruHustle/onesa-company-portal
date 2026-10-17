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
    scrollToTopic();
    window.addEventListener('hashchange', scrollToTopic);
    return () => window.removeEventListener('hashchange', scrollToTopic);
  }, [pathname]);
  return null;
}
