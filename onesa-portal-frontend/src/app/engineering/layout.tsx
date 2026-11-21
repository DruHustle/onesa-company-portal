import type { Metadata } from "next";
export const metadata: Metadata = {
  title: { absolute: "Engineering Docs sign-in | Onesa Portal" },
  robots: { index: false, follow: false },
};
export default function Layout({ children }: { children: React.ReactNode }) {
  return (
    <html data-onesa-product="company" lang="en">
      <head>
        <meta name="color-scheme" content="light dark" />
      </head>
      <body>{children}</body>
    </html>
  );
}
