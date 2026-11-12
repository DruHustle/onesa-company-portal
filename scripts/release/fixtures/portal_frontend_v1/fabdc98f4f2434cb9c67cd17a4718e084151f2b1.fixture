import {notFound, redirect} from "next/navigation";
import { AccessRegistration } from "@/features/access/registration";
export const metadata = { title: "Register | Onesa Portal", robots: { index: false, follow: false } };
export default async function Register({ searchParams }: { searchParams: Promise<{ audience?: string }> }) {
  const { audience } = await searchParams;
  if (process.env.ONESA_IDENTITY_ENABLED === "true" && audience !== "engineering") redirect("/account/register");
  if (process.env.ACCESS_REGISTRATION_ENABLED !== "true") notFound();
  return <AccessRegistration />;
}
