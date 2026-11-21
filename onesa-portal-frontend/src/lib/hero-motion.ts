export type HeroMotionAsset = {
  desktop: string; mobile: string; durationSeconds: number;
  desktopBytes: number; mobileBytes: number;
  desktopSha256: string; mobileSha256: string; rightsRecord: string;
};

export function approvedMotion(asset: HeroMotionAsset | null): asset is HeroMotionAsset {
  if (!asset) return false;
  const local = /^\/images\/hero-motion-[a-z0-9-]+\.(webm|mp4)$/;
  return local.test(asset.desktop) && local.test(asset.mobile)
    && asset.durationSeconds >= 3 && asset.durationSeconds <= 5
    && asset.desktopBytes > 0 && asset.desktopBytes <= 2_000_000
    && asset.mobileBytes > 0 && asset.mobileBytes <= 1_000_000
    && /^[a-f0-9]{64}$/.test(asset.desktopSha256)
    && /^[a-f0-9]{64}$/.test(asset.mobileSha256)
    && asset.rightsRecord.trim().length > 0;
}

type Connection = {saveData?: boolean; effectiveType?: string; downlink?: number};
export function permitsMotion(reduced: boolean, visible: boolean, connection?: Connection) {
  return !reduced && visible && !connection?.saveData
    && !['slow-2g', '2g', '3g'].includes(connection?.effectiveType ?? '')
    && !(connection?.downlink !== undefined && connection.downlink < 1.5);
}

/** Poster stays visible until playback starts; all failures restore it. No retries. */
export function startHeroMotion(host: HTMLElement, asset: HeroMotionAsset): () => void {
  if (!approvedMotion(asset) || typeof window.matchMedia !== 'function') return () => {};
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
  const connection = (navigator as Navigator & {connection?: Connection & EventTarget}).connection;
  const allowed = () => permitsMotion(reduced.matches, document.visibilityState === 'visible', connection);
  if (!allowed()) return () => {};
  const poster = host.querySelector('img');
  if (!poster) return () => {};
  let video: HTMLVideoElement | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;
  const stop = () => {
    disposed = true;
    clearTimeout(timer);
    if (video) { video.pause(); video.removeAttribute('src'); video.load(); video.remove(); }
    poster.removeEventListener('load', begin);
    reduced.removeEventListener('change', stop);
    document.removeEventListener('visibilitychange', visibility);
    connection?.removeEventListener('change', visibility);
  };
  const visibility = () => { if (!allowed()) stop(); };
  const begin = () => {
    if (disposed || !allowed()) return;
    video = document.createElement('video');
    video.muted = true; video.playsInline = true; video.loop = false;
    video.preload = 'none'; video.setAttribute('aria-hidden', 'true');
    video.setAttribute('data-hero-motion-video', '');
    video.addEventListener('error', stop, {once: true});
    video.addEventListener('loadedmetadata', () => {
      if (!video || !Number.isFinite(video.duration) || video.duration > 5.1) stop();
    }, {once: true});
    video.addEventListener('playing', () => {
      if (!video || disposed) return;
      clearTimeout(timer); video.setAttribute('data-playing', 'true');
      timer = setTimeout(stop, 6000);
    }, {once: true});
    video.addEventListener('ended', () => { clearTimeout(timer); }, {once: true});
    video.src = window.matchMedia('(max-width: 760px)').matches ? asset.mobile : asset.desktop;
    host.append(video);
    timer = setTimeout(stop, 5000);
    try { void video.play().catch(stop); } catch { stop(); }
  };
  reduced.addEventListener('change', stop);
  document.addEventListener('visibilitychange', visibility);
  connection?.addEventListener('change', visibility);
  if (poster.complete && poster.naturalWidth > 0) begin();
  else poster.addEventListener('load', begin, {once: true});
  return stop;
}
