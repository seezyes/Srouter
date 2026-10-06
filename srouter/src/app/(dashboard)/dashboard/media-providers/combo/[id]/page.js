import { notFound, redirect } from "next/navigation";
import { getComboById } from "@/lib/db/index.js";
import { getCapabilityComboHref } from "@/shared/utils/capabilityRoutes";

export default async function LegacyComboPage({ params }) {
  const { id } = await params;
  const combo = await getComboById(id);
  const href = combo && getCapabilityComboHref(combo.kind, id);
  if (!href) notFound();
  redirect(href);
}
