import { notFound, redirect } from "next/navigation";
import { getCapabilityProviderHref } from "@/shared/utils/capabilityRoutes";

export default async function LegacyProviderPage({ params }) {
  const { kind, id } = await params;
  const href = getCapabilityProviderHref(kind, id);
  if (!href) notFound();
  redirect(href);
}
