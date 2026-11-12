import { notFound, redirect } from "next/navigation";
export const metadata = { title: "Register | Onesa Portal", robots: { index: false, follow: false } };
export default async function Register({ searchParams }: { searchParams: Promise<{ audience?: string }> }) {
  if (process.env.ACCESS_REGISTRATION_ENABLED !== "true") notFound();
  const { audience } = await searchParams;
  redirect("/account/register?next=" + (audience === "engineering" ? "/engineering" : "/admin"));
}
