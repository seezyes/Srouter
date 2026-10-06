import { notFound, redirect } from "next/navigation";
import { getCapabilityListingHref } from "@/shared/utils/capabilityRoutes";

export default async function LegacyKindPage({ params }) {
  const { kind } = await params;
  const href = getCapabilityListingHref(kind);
  if (!href) notFound();
  redirect(href);
}
