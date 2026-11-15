import { legacyEngineeringFixture } from "@/lib/engineering-test-fixture";
import { OnesaAccount } from "@/features/account/account";
export default async function Register({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  const { next } = await searchParams;
  return <OnesaAccount mode="register" adminEntry={next === "/admin"} legacyDocsRegistration={next === "/engineering" && legacyEngineeringFixture()} accessEnabled={process.env.ACCESS_REGISTRATION_ENABLED === "true"}/>;
}
