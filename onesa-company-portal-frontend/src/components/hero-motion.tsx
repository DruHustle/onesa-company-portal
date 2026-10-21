'use client';
import {useEffect, useRef, type ReactNode} from 'react';
import {startHeroMotion, type HeroMotionAsset} from '@/lib/hero-motion';

export function HeroMotion({asset, className, children}: {
  asset: HeroMotionAsset; className: string; children: ReactNode;
}) {
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => host.current ? startHeroMotion(host.current, asset) : undefined, [asset]);
  return <div ref={host} className={className} aria-hidden="true">{children}</div>;
}
