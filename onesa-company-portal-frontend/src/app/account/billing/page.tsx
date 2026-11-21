import type { Metadata } from "next";
import { BillingPage } from "@/features/account/billing/page";

export const metadata: Metadata = { title: "Billing | Onesa", robots: { index: false, follow: false } };
export default function Billing() { return <BillingPage />; }
