import { identityAdministrationRequired } from "@/lib/identity-administration";
import { notFound, redirect } from "next/navigation";
export const metadata = { title: "Register | Onesa Portal", robots: { index: false, follow: false } };
export default async function Register({ searchParams }: { searchParams: Promise<{ audience?: string }> }) {
  const { audience } = await searchParams;
  if (!identityAdministrationRequired() && process.env.ACCESS_REGISTRATION_ENABLED !== "true") notFound();
  redirect("/account/register?next=" + (audience === "engineering" ? "/engineering" : "/admin"));
}
