import { notFound } from "next/navigation";
import ProviderDetailPage from "@/shared/components/capability-pages/provider/ProviderDetailPage";
import { isCapabilityKind, isWebCapability } from "@/shared/utils/capabilityRoutes";

export default async function CapabilityProviderPage({ params }) {
  const { kind } = await params;
  if (!isCapabilityKind(kind) || isWebCapability(kind)) notFound();
  return <ProviderDetailPage kind={kind} />;
}
