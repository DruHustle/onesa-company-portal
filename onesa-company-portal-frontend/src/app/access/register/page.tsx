import {notFound} from "next/navigation";
import { AccessRegistration } from "@/features/access/registration";
export const metadata = { title: "Register | Onesa Portal", robots: { index: false, follow: false } };
export default function Register() { if(process.env.ACCESS_REGISTRATION_ENABLED!=="true") notFound(); return <AccessRegistration />; }
