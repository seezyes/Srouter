import { redirect } from "next/navigation";

export default function RemovedUISettingsPage() {
  redirect("/dashboard/profile");
}
