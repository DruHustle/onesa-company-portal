import { notFound } from "next/navigation";
import { OnesaAccount } from "@/features/account/account";
export default async function Confirm({ searchParams }: { searchParams: Promise<{ approval?: string }> }) {
  const { approval } = await searchParams;
  if (approval === "1" && process.env.ACCESS_REGISTRATION_ENABLED !== "true") notFound();
  return <OnesaAccount mode="confirm" approvalConfirmation={approval === "1"} />;
}
