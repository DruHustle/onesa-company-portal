import { identityAdministrationUrl } from "@/lib/identity-administration";
import { redirect } from "next/navigation";
import { AdminPortal } from "@/features/admin/portal";

export default async function Admin({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const identityAdmin = identityAdministrationUrl();
  if (identityAdmin && (await searchParams).section === "Users") redirect(identityAdmin);
  const accessEnabled = process.env.ACCESS_REGISTRATION_ENABLED === "true";
  const environment = process.env.VERCEL_ENV === "production" ? "PRODUCTION" : process.env.VERCEL_ENV === "preview" ? "STAGING" : process.env.VERCEL_ENV === "development" || process.env.NODE_ENV === "development" ? "DEVELOPMENT" : undefined;
  return <AdminPortal managedLogin={process.env.ONESA_IDENTITY_PORTAL_LOGIN === "managed"} identityAdmin={identityAdmin} environment={environment} identityEnabled={process.env.ONESA_IDENTITY_ENABLED === "true"} accessEnabled={accessEnabled} engineeringEnabled={process.env.ENGINEERING_SIGNIN_ENABLED === "true"} />;
}
