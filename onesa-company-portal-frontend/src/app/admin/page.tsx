import { notFound } from "next/navigation";
import { AdminPortal } from "@/features/admin/portal";
import { OnesaAccount } from "@/features/account/account";
import { productAccountPath } from "@/lib/account-return";
import Account from "../account/page";

type Search = Record<string, string | string[] | undefined>;

export default async function Admin({ searchParams }: { searchParams: Promise<Search> }) {
  const params = await searchParams;
  const accessEnabled = process.env.ACCESS_REGISTRATION_ENABLED === "true";
  if (params.interaction !== undefined) {
    const uid = params.interaction;
    if (Object.keys(params).length !== 1 || typeof uid !== "string" || !productAccountPath(uid)) notFound();
    return <OnesaAccount key={uid} interactionId={uid} />;
  }
  if (params.entry !== undefined) {
    if (params.docs !== undefined || params.next !== undefined || params.returnTo !== undefined) notFound();
    if (params.entry === "register") return <OnesaAccount mode="register" accessEnabled={accessEnabled} />;
    if (params.entry !== "account") notFound();
  }
  if (params.entry || params.docs !== undefined || params.next !== undefined || params.returnTo !== undefined) {
    return <Account searchParams={searchParams} />;
  }
  const environment = process.env.VERCEL_ENV === "production" ? "PRODUCTION" : process.env.VERCEL_ENV === "preview" ? "STAGING" : process.env.VERCEL_ENV === "development" || process.env.NODE_ENV === "development" ? "DEVELOPMENT" : undefined;
  return <AdminPortal environment={environment} identityEnabled={process.env.ONESA_IDENTITY_ENABLED === "true"} accessEnabled={accessEnabled} engineeringEnabled={process.env.ENGINEERING_SIGNIN_ENABLED === "true"} />;
}
