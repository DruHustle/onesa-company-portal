import { AccountDeletion } from "@/features/account/deletion";

export const metadata = {
  title: "Request Onesa account deletion",
  robots: { index: false },
};
export default function DeletionPage() {
  return <AccountDeletion />;
}
