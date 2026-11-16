import { notFound } from "next/navigation";
import { identityAdministrationRequired, identityAdministrationUrl } from "@/lib/identity-administration";
import { OnesaAccount } from "@/features/account/account";
export default async function Confirm({ searchParams }: { searchParams: Promise<{ approval?: string }> }) {
  const { approval } = await searchParams;
  const identityAdmin = identityAdministrationUrl();
  const identityAdminRequired = identityAdministrationRequired();
  if (approval === "1" && process.env.ACCESS_REGISTRATION_ENABLED !== "true") notFound();
  return <OnesaAccount mode="confirm" identityAdmin={identityAdmin} identityAdminRequired={identityAdminRequired} approvalConfirmation={approval === "1"} />;
}
