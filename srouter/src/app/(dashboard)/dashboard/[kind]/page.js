import { notFound } from "next/navigation";
import CapabilityKindPage from "@/shared/components/capability-pages/KindPage";
import { isCapabilityKind, isWebCapability } from "@/shared/utils/capabilityRoutes";

export default async function CapabilityPage({ params }) {
  const { kind } = await params;
  if (!isCapabilityKind(kind) || isWebCapability(kind)) notFound();
  return <CapabilityKindPage kind={kind} />;
}
