import { notFound } from "next/navigation";
import ComboDetailPage from "@/shared/components/capability-pages/ComboDetailPage";
import { isWebCapability } from "@/shared/utils/capabilityRoutes";

export default async function WebComboPage({ params }) {
  const { kind } = await params;
  if (!isWebCapability(kind)) notFound();
  return <ComboDetailPage kind={kind} />;
}
