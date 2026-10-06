import { notFound, redirect } from "next/navigation";
import { isWebCapability } from "@/shared/utils/capabilityRoutes";

export default async function WebKindPage({ params }) {
  const { kind } = await params;
  if (!isWebCapability(kind)) notFound();
  redirect("/dashboard/search");
}
