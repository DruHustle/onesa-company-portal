import {heroMotionAsset} from '@/config/hero-motion';
import {approvedMotion} from '@/lib/hero-motion';

export async function HeroMedia({className}: {className: string}) {
  const image = <img src="/images/onesa-home-hero-1536.webp" srcSet="/images/onesa-home-hero-640.webp 640w, /images/onesa-home-hero-1024.webp 1024w, /images/onesa-home-hero-1536.webp 1536w" sizes="100vw" width="1536" height="1024" fetchPriority="high" alt=""/>;
  if (process.env.ONESA_HERO_MOTION_ENABLED !== 'true' || !approvedMotion(heroMotionAsset)) {
    return <picture className={className} aria-hidden="true">{image}</picture>;
  }
  const {HeroMotion} = await import('./hero-motion');
  return <HeroMotion asset={heroMotionAsset} className={className}><picture>{image}</picture></HeroMotion>;
}
