import { notFound, redirect } from "next/navigation";
import { docsAccountPath } from "@/lib/account-return";

export default async function SignIn({ params }: { params: Promise<{ uid: string }> }) {
  const target = docsAccountPath((await params).uid);
  if (process.env.ENGINEERING_SIGNIN_ENABLED !== "true" || !target) notFound();
  redirect(target);
}
