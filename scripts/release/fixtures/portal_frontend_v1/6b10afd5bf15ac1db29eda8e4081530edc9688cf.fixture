import { notFound } from "next/navigation";
import { OnesaAccount } from "@/features/account/account";
export default async function SignIn({ params }: { params: Promise<{ uid: string }> }) { const { uid } = await params; if (!/^[A-Za-z0-9_-]{8,128}$/.test(uid)) notFound(); return <OnesaAccount interactionId={uid} />; }
