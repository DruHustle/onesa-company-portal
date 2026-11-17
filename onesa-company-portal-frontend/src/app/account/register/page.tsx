import { identityRegistrationUrl } from "@/lib/identity-administration";
import { notFound, redirect } from "next/navigation";
import { legacyEngineeringFixture } from "@/lib/engineering-test-fixture";
import { OnesaAccount } from "@/features/account/account";
import { docsAccountPath, productAccountPath } from "@/lib/account-return";
import styles from "@/features/account/account.module.css";

export default async function Register({ searchParams }: {
  searchParams: Promise<{ next?: string; docs?: string; interaction?: string; audience?: string }>;
}) {
  const { next, docs, interaction, audience } = await searchParams;
  const docsReturnPath = typeof docs === "string" ? docsAccountPath(docs) : null;
  if (legacyEngineeringFixture()) {
    return <OnesaAccount mode="register" docsReturnPath={docsReturnPath} adminEntry={next === "/admin"} legacyDocsRegistration={next === "/engineering"} accessEnabled={process.env.ACCESS_REGISTRATION_ENABLED === "true"}/>;
  }
  const productReturnPath = typeof interaction === "string" ? productAccountPath(interaction) : null;
  if ((docs !== undefined && !docsReturnPath) || (interaction !== undefined && !productReturnPath) ||
      (docsReturnPath && productReturnPath)) notFound();
  const returnPath = docsReturnPath || productReturnPath;
  const isAdmin = next === "/admin" || audience === "admin";
  const destination = identityRegistrationUrl(isAdmin ? "admin" : "user");
  if (destination && !returnPath) redirect(destination);
  return <main className={styles.shell}><section className={styles.card} aria-labelledby="account-title">
    <h1 id="account-title">{isAdmin ? "Request administrator access" : "Onesa Account"}</h1>
    {destination ? <p><a href={destination} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer">Register with Onesa Identity</a></p>
      : <p role="status">Registration is temporarily unavailable. Please try again later.</p>}
    {returnPath && <p><a href={returnPath} referrerPolicy="no-referrer">{docsReturnPath ? "Return to document sign-in" : "Return to product sign-in"}</a></p>}
  </section></main>;
}
