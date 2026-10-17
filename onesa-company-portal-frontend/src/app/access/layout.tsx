import type { Metadata } from "next";
export const metadata: Metadata = { robots: { index: false, follow: false }, referrer: "no-referrer" };
export default function Layout({ children }: { children: React.ReactNode }) { return <html data-onesa-product="company" lang="en"><head><meta name="color-scheme" content="light dark" /></head><body>{children}</body></html>; }
