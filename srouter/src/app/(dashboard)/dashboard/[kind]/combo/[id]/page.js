import { notFound } from "next/navigation";
import ComboDetailPage from "@/shared/components/capability-pages/ComboDetailPage";
import { isCapabilityKind, isWebCapability } from "@/shared/utils/capabilityRoutes";

export default async function CapabilityComboPage({ params }) {
  const { kind } = await params;
  if (!isCapabilityKind(kind) || isWebCapability(kind)) notFound();
  return <ComboDetailPage kind={kind} />;
}
