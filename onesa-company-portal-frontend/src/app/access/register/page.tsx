import { notFound, redirect } from "next/navigation";
import { legacyEngineeringFixture } from "@/lib/engineering-test-fixture";

export const metadata = { title: "Register | Onesa Portal", robots: { index: false, follow: false } };

export default async function Register({ searchParams }: { searchParams: Promise<{ audience?: string }> }) {
  const { audience } = await searchParams;
  if (legacyEngineeringFixture()) {
    if (process.env.ACCESS_REGISTRATION_ENABLED !== "true") notFound();
    redirect("/account/register?next=" + (audience === "engineering" ? "/engineering" : "/admin"));
  }
  redirect(audience === undefined || audience === "admin" ? "/account/register?next=/admin" : "/account/register");
}
