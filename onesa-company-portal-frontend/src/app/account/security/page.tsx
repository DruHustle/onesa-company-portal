import { AccountSecurity } from "@/features/account/security";
export default async function Security({searchParams}: {searchParams: Promise<{next?: string}>}) {
  return <AccountSecurity legacyAdmin={(await searchParams).next === "/admin" && process.env.ONESA_IDENTITY_ENABLED !== "true"} />;
}
