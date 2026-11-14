import { identityAdministrationUrl } from "@/lib/identity-administration";
import { redirect } from "next/navigation";
import { legacyEngineeringFixture } from "@/lib/engineering-test-fixture";
import { OnesaAccount } from "@/features/account/account";
export default async function Register({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  const administration = identityAdministrationUrl();
  if (administration) redirect(new URL("/register#registration", administration).href);
  const { next } = await searchParams;
  return <OnesaAccount mode="register" adminEntry={next === "/admin"} legacyDocsRegistration={next === "/engineering" && legacyEngineeringFixture()} accessEnabled={process.env.ACCESS_REGISTRATION_ENABLED === "true"}/>;
}
