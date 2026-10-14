'use client';

import Link, {useLinkStatus} from 'next/link';
import {useParams} from 'next/navigation';
import {createPortal} from 'react-dom';
import type {ComponentProps} from 'react';

function NavigationStatus() {
  const {pending} = useLinkStatus();
  const {locale} = useParams<{locale:string}>();
  if (!pending) return null;
  // The native mobile disclosure closes on selection. Keep feedback outside it.
  return createPortal(<p className="navigation-status" role="status" aria-live="polite">
    {locale === 'de' ? 'Seite wird geladen…' : 'Loading page…'}
  </p>, document.body);
}

export function ResponsiveLink({children,...props}:ComponentProps<typeof Link>) {
  return <Link {...props}>{children}<NavigationStatus /></Link>;
}
