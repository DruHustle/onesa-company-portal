import { notFound, redirect } from "next/navigation";
import { OnesaAccount } from "@/features/account/account";
import { EngineeringSignIn } from "@/features/engineering/sign-in";
import { accountReturnPath, docsAccountPath } from "@/lib/account-return";

export default async function Account({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { docs, next, returnTo, reauthenticate } = await searchParams;
  const accessEnabled = process.env.ACCESS_REGISTRATION_ENABLED === "true";
  if (typeof returnTo === "string" && docs === undefined && next === undefined) {
    const legacy = accountReturnPath(new URLSearchParams({returnTo}).toString());
    if (legacy) redirect(docsAccountPath(legacy.slice("/engineering/sign-in/".length))! + (reauthenticate === "1" ? "&reauthenticate=1" : ""));
  }
  if (docs !== undefined) {
    if (typeof docs !== "string" || !docsAccountPath(docs) || next !== undefined || returnTo !== undefined || process.env.ENGINEERING_SIGNIN_ENABLED !== "true") notFound();
    const environment = process.env.VERCEL_ENV === "production" ? "Production" : process.env.VERCEL_ENV === "preview" ? "Staging" : "Development";
    return <EngineeringSignIn uid={docs} environment={environment} shared={process.env.ONESA_IDENTITY_ENABLED === "true"} fresh={reauthenticate === "1"} />;
  }
  return <OnesaAccount adminEntry={next === "/admin"} accessEnabled={accessEnabled} legacyAdmin={next === "/admin" && process.env.ONESA_IDENTITY_ENABLED !== "true"} />;
}
