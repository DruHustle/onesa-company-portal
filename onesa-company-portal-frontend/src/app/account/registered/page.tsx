import { RegistrationReturn } from "@/features/account/registration-handoff";
import styles from "@/features/account/account.module.css";

export const metadata = { title: "Return to Company Portal", robots: { index: false, follow: false } };

export default async function Registered({ searchParams }: { searchParams: Promise<{ audience?: string }> }) {
  const { audience } = await searchParams;
  const admin = audience === "admin";
  return <main className={styles.shell}><section className={styles.card} aria-labelledby="return-title">
    <RegistrationReturn audience={admin ? "admin" : "user"}/>
    <h1 id="return-title">Company Portal</h1>
    {admin ? <>
      <p>Administrator access requires approval. Once approved, sign in to open the staff workspace.</p>
      <a href="/admin#workspace">Sign in to the staff workspace</a>
    </> : <>
      <p>You have returned to Company Portal from Onesa Identity.</p>
      <a href="/account">Open my Onesa account</a>
    </>}
    <p><a href="/en">Visit the Onesa company website</a></p>
  </section></main>;
}
