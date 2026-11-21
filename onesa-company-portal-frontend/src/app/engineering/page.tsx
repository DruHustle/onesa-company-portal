import { internalDocumentsOrigin } from "@/config/internal-documents";
import { redirect } from "next/navigation";
export default function Engineering() {
  if (internalDocumentsOrigin) redirect(internalDocumentsOrigin + "/");
  return <main><h1>Internal Documents</h1><p>Document access is currently unavailable.</p></main>;
}
