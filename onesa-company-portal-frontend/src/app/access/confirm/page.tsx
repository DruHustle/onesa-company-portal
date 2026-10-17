import {notFound} from "next/navigation";
import { AccessRegistration } from "@/features/access/registration";
export const metadata = { title: "Complete registration | Onesa Portal", robots: { index: false, follow: false }, referrer: "no-referrer" };
export default function Confirm() { if(process.env.ACCESS_REGISTRATION_ENABLED!=="true") notFound(); return <AccessRegistration confirmation />; }
