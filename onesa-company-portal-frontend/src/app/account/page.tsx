import { identityAdministrationUrl } from "@/lib/identity-administration";
import { legacyEngineeringFixture } from "@/lib/engineering-test-fixture";
import { notFound, redirect } from "next/navigation";
import { OnesaAccount } from "@/features/account/account";
import { EngineeringSignIn } from "@/features/engineering/sign-in";
import { accountReturnPath, docsAccountPath, productAccountPath } from "@/lib/account-return";

export default async function Account({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const params = await searchParams;
  const { docs, next, returnTo, reauthenticate, interaction, entry } = params;
  const identityAdmin = identityAdministrationUrl();
  if (identityAdmin && params.tab === "access" && Object.keys(params).length === 1) redirect(identityAdmin);
  if (process.env.ONESA_IDENTITY_PORTAL_LOGIN === "managed" && next === "/admin" && Object.keys(params).length === 1)
    redirect("/admin#workspace");
  const accessEnabled = process.env.ACCESS_REGISTRATION_ENABLED === "true";
  if (entry !== undefined) {
    if (docs !== undefined || next !== undefined || returnTo !== undefined || interaction !== undefined) notFound();
    if (entry === "register" && Object.keys(params).length === 1) redirect("/account/register");
    if (entry !== "account") notFound();
  }
  if (interaction !== undefined) {
    if (Object.keys(params).length !== 1 || typeof interaction !== "string" || !productAccountPath(interaction)) notFound();
    return <OnesaAccount identityAdmin={identityAdmin} key={interaction} interactionId={interaction} />;
  }
  if (typeof returnTo === "string" && docs === undefined && next === undefined) {
    const legacy = accountReturnPath(new URLSearchParams({returnTo}).toString());
    if (legacy) redirect(docsAccountPath(legacy.slice("/engineering/sign-in/".length))! + (reauthenticate === "1" ? "&reauthenticate=1" : ""));
  }
  if (docs !== undefined) {
    if (typeof docs !== "string" || !docsAccountPath(docs) || next !== undefined || returnTo !== undefined || process.env.ENGINEERING_SIGNIN_ENABLED !== "true") notFound();
    const environment = process.env.VERCEL_ENV === "production" ? "Production" : process.env.VERCEL_ENV === "preview" ? "Staging" : "Development";
    return <EngineeringSignIn uid={docs} environment={environment} shared={process.env.ONESA_IDENTITY_ENABLED === "true"} legacyFixture={legacyEngineeringFixture()} fresh={reauthenticate === "1"} />;
  }
  return <OnesaAccount identityAdmin={identityAdmin} adminEntry={next === "/admin"} accessEnabled={accessEnabled} legacyAdmin={next === "/admin" && process.env.ONESA_IDENTITY_ENABLED !== "true"} />;
}
