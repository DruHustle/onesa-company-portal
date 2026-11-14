import { redirect } from "next/navigation";
export default function Engineering() {
  if (process.env.NEXT_PUBLIC_INTERNAL_DOCUMENTS_CANONICAL === "true") {
    redirect("https://docs.internal.onesa.eu/");
  }
  return <main><h1>Internal Documents</h1><p>Document access is currently unavailable.</p></main>;
}
