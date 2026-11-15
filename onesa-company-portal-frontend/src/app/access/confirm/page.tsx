import { notFound, redirect } from "next/navigation";
export default function Confirm() {
  if (process.env.ACCESS_REGISTRATION_ENABLED !== "true") notFound();
  redirect("/account/confirm?approval=1");
}
