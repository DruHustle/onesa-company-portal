import { notFound } from "next/navigation";
import { EngineeringSignIn } from "@/features/engineering/sign-in";
export default async function SignIn({
  params,
}: {
  params: Promise<{ uid: string }>;
}) {
  const { uid } = await params;
  if (
    process.env.ENGINEERING_SIGNIN_ENABLED !== "true" ||
    !/^[A-Za-z0-9_-]{8,128}$/.test(uid)
  )
    notFound();
  const environment =
    process.env.VERCEL_ENV === "production"
      ? "Production"
      : process.env.VERCEL_ENV === "preview"
        ? "Staging"
        : "Development";
  return <EngineeringSignIn uid={uid} environment={environment} />;
}
