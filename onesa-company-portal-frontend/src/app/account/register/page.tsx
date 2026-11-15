import { identityAdministrationRequired, identityAdministrationUrl } from "@/lib/identity-administration";
import { redirect } from "next/navigation";
import { legacyEngineeringFixture } from "@/lib/engineering-test-fixture";
import { OnesaAccount } from "@/features/account/account";
import { docsAccountPath } from "@/lib/account-return";
export default async function Register({ searchParams }: { searchParams: Promise<{ next?: string; docs?: string }> }) {
  const administration = identityAdministrationUrl();
  const identityAdminRequired = identityAdministrationRequired();
  const { next, docs } = await searchParams;
  const docsReturnPath = typeof docs === "string" ? docsAccountPath(docs) : null;
  if (administration && !docsReturnPath) redirect(new URL("/register#registration", administration).href);
  return <OnesaAccount mode="register" identityAdmin={administration} identityAdminRequired={identityAdminRequired} docsReturnPath={docsReturnPath} adminEntry={next === "/admin"} legacyDocsRegistration={next === "/engineering" && legacyEngineeringFixture()} accessEnabled={process.env.ACCESS_REGISTRATION_ENABLED === "true"}/>;
}
