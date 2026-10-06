import { redirect } from "next/navigation";

export default function LegacyWebPage() {
  redirect("/dashboard/search");
}
