import { notFound } from "next/navigation";
import ProviderDetailPage from "@/shared/components/capability-pages/provider/ProviderDetailPage";
import { isWebCapability } from "@/shared/utils/capabilityRoutes";

export default async function WebProviderPage({ params }) {
  const { kind } = await params;
  if (!isWebCapability(kind)) notFound();
  return <ProviderDetailPage kind={kind} />;
}
